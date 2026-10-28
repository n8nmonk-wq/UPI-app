import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { OrderStatus, nextStatus } from './status.js';

export { OrderStatus };

export class OrderStore {
  constructor(dbPath) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        payment_id TEXT UNIQUE,
        sku TEXT NOT NULL,
        amount_paise INTEGER NOT NULL,
        currency TEXT NOT NULL,
        status TEXT NOT NULL,
        settlement_state TEXT,
        utr TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        paid_at TEXT
      );
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        delivery_id TEXT PRIMARY KEY,
        order_id TEXT,
        event TEXT,
        received_at TEXT NOT NULL
      );
      -- One bank credit (UTR) can only ever pay one order.
      CREATE UNIQUE INDEX IF NOT EXISTS orders_utr_unique ON orders(utr) WHERE utr IS NOT NULL;
    `);
  }

  create({ id, sku, amountPaise, currency }) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO orders (id, sku, amount_paise, currency, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, sku, amountPaise, currency, OrderStatus.PENDING, now, now);
    return this.get(id);
  }

  attachPayment(id, paymentId) {
    this.db.prepare('UPDATE orders SET payment_id = ?, updated_at = ? WHERE id = ?')
      .run(paymentId, new Date().toISOString(), id);
  }

  remove(id) {
    this.db.prepare('DELETE FROM orders WHERE id = ? AND payment_id IS NULL').run(id);
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!row) return null;
    return {
      id: row.id,
      paymentId: row.payment_id,
      sku: row.sku,
      amountPaise: BigInt(row.amount_paise),
      currency: row.currency,
      status: row.status,
      settlementState: row.settlement_state,
      utr: row.utr,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      paidAt: row.paid_at
    };
  }

  /**
   * Applies a gateway-derived status (see nextStatus for the rules) and, for a paid order, records
   * the settlement state and UTR. Returns the updated order.
   */
  transition(id, status, { settlementState = null, utr = null } = {}) {
    const order = this.get(id);
    if (!order) return null;
    const now = new Date().toISOString();
    const target = nextStatus(order.status, status);
    if (target) {
      this.db.prepare(`
        UPDATE orders SET status = ?, settlement_state = COALESCE(?, settlement_state),
          paid_at = CASE WHEN ? = 'PAID' THEN ? ELSE paid_at END, updated_at = ?
        WHERE id = ? AND status = ?
      `).run(target, settlementState, target, now, now, id, order.status);
    } else if (order.status === OrderStatus.PAID && settlementState) {
      this.db.prepare('UPDATE orders SET settlement_state = ?, updated_at = ? WHERE id = ?').run(settlementState, now, id);
    }
    if (utr && (target === OrderStatus.PAID || order.status === OrderStatus.PAID)) {
      try {
        this.db.prepare('UPDATE orders SET utr = ?, updated_at = ? WHERE id = ? AND utr IS NULL').run(utr, now, id);
      } catch (err) {
        console.warn(`[Rupee Store] UTR ${utr} is already recorded on another order; not reusing it for ${id}.`);
      }
    }
    return this.get(id);
  }

  hasDelivery(deliveryId) {
    return Boolean(this.db.prepare('SELECT 1 FROM webhook_deliveries WHERE delivery_id = ?').get(deliveryId));
  }

  /** Marks a webhook delivery as processed. Returns false when it already was. */
  recordDelivery(deliveryId, orderId, event) {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO webhook_deliveries (delivery_id, order_id, event, received_at) VALUES (?, ?, ?, ?)
    `).run(deliveryId, orderId, event, new Date().toISOString());
    return result.changes > 0;
  }

  close() {
    this.db.close();
  }
}
