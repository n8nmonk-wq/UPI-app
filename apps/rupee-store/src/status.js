/** Store-side order states. Only a verified gateway read can move an order to PAID. */
export const OrderStatus = Object.freeze({
  PENDING: 'PENDING',
  PAID: 'PAID',
  REVIEW: 'REVIEW',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED'
});

export const ALL_STATUSES = Object.freeze(Object.values(OrderStatus));

/** Statuses after which the store stops asking the gateway (REVIEW can still resolve either way). */
export const SETTLED_STATUSES = new Set([OrderStatus.PAID, OrderStatus.FAILED, OrderStatus.EXPIRED, OrderStatus.CANCELLED]);

/**
 * Decides whether an order may move from `current` to `target`. The gateway is the source of
 * truth, so the store mirrors it, with two guards:
 *  - PAID is never left (a late or replayed FAILED/EXPIRED event cannot undo a received payment);
 *  - nothing goes back to PENDING once the gateway reported an outcome.
 * A late credit can still move FAILED/EXPIRED to REVIEW or PAID, because the gateway says so.
 * Returns the new status, or null when nothing should change.
 */
export function nextStatus(current, target) {
  if (!ALL_STATUSES.includes(target)) return null;
  if (current === target) return null;
  if (current === OrderStatus.PAID) return null;
  if (target === OrderStatus.PENDING) return null;
  return target;
}
