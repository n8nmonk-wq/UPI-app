# HANDOFF — One Rupee UPI Store on YOUPI PG (Vercel + Neon)

This is the complete handoff for this project. It is written so that a **new Claude account**
(with Vercel and Neon connected) or a developer can take it from zero to a live, working ₹1 UPI
payment without any earlier context.

- **Repository:** https://github.com/bhaviksiddhapura/UPI-app
- **Branch with all the work:** `claude/gifted-ritchie-m9zzjp`
  (browse: https://github.com/bhaviksiddhapura/UPI-app/tree/claude/gifted-ritchie-m9zzjp,
  zip: https://github.com/bhaviksiddhapura/UPI-app/archive/refs/heads/claude/gifted-ritchie-m9zzjp.zip)

> **Experimental project.** YOUPI PG is a research gateway: it confirms UPI payments by reading the
> merchant's own bank alerts. It is not a bank- or NPCI-approved payment aggregator. Keep amounts
> small, check your bank app for anything that matters, and get legal/compliance advice before
> taking payments from the public. See the notice at the top of `README.md`.

---

## 0. In one minute

**Goal:** a one-page website selling one product for **₹1**. The customer pays with any UPI app
straight into the merchant's own UPI ID. The order is confirmed automatically, and the merchant
sees every order live on a dashboard.

**The pieces:**

| Piece | Runs on | What it does |
|---|---|---|
| **Store** (`apps/rupee-store`) | **Vercel** (static page + serverless functions) | Product page, order API, signed-webhook receiver, live admin dashboard |
| **Database** | **Neon Postgres** | Orders, per-order event log, webhook deliveries, encrypted gateway credentials |
| **Gateway** (YOUPI PG: payment API, checkout portal, admin, observers) | **The merchant's Windows PC** | Creates UPI payment sessions (QR for exactly ₹1.00 to the merchant UPI ID), WhatsApp OTP sign-in, matches bank credits to the right customer, sends signed webhooks |
| **Observer phone** | The merchant's Android phone (the one that gets the bank credit SMS/notifications) | Reports each credit (amount + UTR) to the gateway, HMAC-signed |
| **Tunnel** | The merchant's PC (`cloudflared`) | Gives the gateway a public `https://` address for customers, the phone and the store |

**Why the gateway is not on Vercel:** it needs always-on processes (WhatsApp session, 5-minute
payment timers, webhook retries, a server the phone reports to). Vercel functions are short-lived
request handlers. So the gateway stays on the PC, and **customers can only pay while the PC,
the gateway and the tunnel are running.**

```
 Customer browser
   │ 1. opens https://<store>.vercel.app, clicks "Buy now"
   ▼
 Vercel: POST /api/orders ──(merchant key)──► Gateway on PC (via tunnel)  ──► creates ₹1 session
   │                                             │
   │ 2. redirect to https://<tunnel>/checkout/<id> │ WhatsApp OTP, then UPI QR (pa=<merchant UPI>, am=1.00)
   ▼                                             │
 Customer pays ₹1 in GPay/PhonePe/Paytm/BHIM ──► merchant bank ──► credit SMS/notification on the phone
                                                 │
                    Observer app (signed report) ─┘─► gateway matches amount + active slot + UTR
                                                 │
 Vercel: POST /api/webhook ◄──(HMAC-signed)───────┘   3. store verifies the signature, then reads the
   │                                                       payment back from the gateway (merchant key)
   ▼                                                       and marks the order PAID only if order id,
 Neon: orders.status = PAID, utr = 123456789012            payment id, amount, currency and UPI all match
   │
   ▼
 Customer page shows "Payment received" + UTR;  /admin.html shows it live (2 s refresh)
```

---

## 1. What has been built so far (history)

1. **Imported the YOUPI PG project** (it was uploaded as `YouPI-PG-main.zip`) and got all services
   running locally.
2. **Built the One Rupee Store** (`apps/rupee-store`): a one-product page, order API, signed webhook
   handling and a local SQLite version for running it on the PC.
3. **Hardened the gateway:**
   - `YOUPI_REQUIRE_MERCHANT_KEY=true` blocks anonymous payment creation.
   - The publicly known example Android pairing secret from `.env.example` is now refused; a
     random per-install secret is used instead.
   - The showcase demo store only starts if `ENABLE_DEMO_STORE=true`.
4. **Built the setup tooling:**
   - `npm run store:configure`: sets the UPI ID and webhook, issues fresh keys, links the online store.
   - `npm run observer:tunnel`: public address, pairing QR, store link, order re-check every minute.
   - `npm run observer:pair`: writes the phone pairing QR page.
   - `setup.ps1`: one-command Windows setup.
5. **Moved the online store to Vercel + Neon**, with a live dashboard. An earlier Netlify attempt
   was dropped; see §11 for leftover resources.
6. **Fixed bugs found while testing:**
   - The customer page stopped updating before the UTR arrived, so customers never saw it.
   - `hidden` page elements could still be shown by CSS.
   - A webhook could be recorded as processed before it was actually processed.
   - An encryption-key change made every endpoint crash instead of reporting "not linked".
7. **Tested:**
   - 28 store tests: 10 unit tests plus 18 integration tests that run the Vercel functions
     against a real Neon branch.
   - A browser end-to-end purchase (store → real gateway → observer simulator → PAID with UTR)
     through the same handlers Vercel runs.
   - **No real-money payment has been made yet.** That needs the merchant's phone, WhatsApp and a
     real ₹1 transfer (§6).

---

## 2. Repository map (what matters)

```
apps/rupee-store/            ← the Vercel project (set Vercel "Root Directory" to this folder)
  api/                       ← Vercel Functions (export default { fetch(request) })
    product.js               GET  /api/product        product + "can customers pay now?"
    health.js                GET  /api/health         database / link status
    orders/index.js          POST /api/orders         start a ₹1 checkout (price fixed server-side)
    orders/[id].js           GET  /api/orders/:id     customer order status (re-checked with gateway)
    webhook.js               POST /api/webhook        gateway webhook (HMAC verified + read-back)
    admin/link.js            POST /api/admin/link     PC links gateway credentials / public URL (admin token)
    admin/orders.js          GET  /api/admin/orders   live dashboard feed (admin token)
    admin/sync.js            POST /api/admin/sync     re-check open orders (called every minute by the PC)
  lib/store.js               DB access, encryption, verified sync, rate limits
  src/                       shared logic (gateway client, status rules, product) + local SQLite store
  public/                    index.html/app.js (store), admin.html/admin.js (dashboard), CSS
  schema.sql                 Neon schema (idempotent)
  vercel.json                headers, function duration, output dir = public
  dev-server.js              local Vercel-style runner (npm run store:dev)
  test/api.test.js           integration tests (need TEST_DATABASE_URL = a Neon test branch)
scripts/configure-store.js   npm run store:configure
scripts/observer-tunnel.js   npm run observer:tunnel
scripts/observer-pairing.js  npm run observer:pair
setup.ps1                    one-command Windows setup for the merchant PC
apps/payment-api, apps/checkout-portal, apps/merchant-admin, ...   the YOUPI PG gateway
apps/android-observer-app/youpi-sms-gateway.apk                    the phone observer app (+ .sha256)
docs/RUPEE_STORE.md          store details and security controls
docs/CONFIGURATION.md        all environment variables
```

---

## 3. Accounts and tools needed

| Who | Needs |
|---|---|
| Whoever deploys (Claude agent or developer) | Vercel account, Neon account (or Neon via the Vercel Marketplace), access to the GitHub repo |
| Merchant | Windows PC (Node.js 22+; 24 LTS recommended), Git (optional), an Android phone that receives the bank credit alerts for the UPI ID, a WhatsApp account for sending OTPs, and a second UPI account to test-pay ₹1 from |

---

## 4. Part A — Deploy the store (for the Claude agent / developer)

Work from the branch `claude/gifted-ritchie-m9zzjp`. **Never commit secrets** (database URLs,
tokens, keys) to the repository. They go into Vercel environment variables only.

### A1. Create the Neon database

1. Create a Neon project. Suggested name `one-rupee-upi-store`, region **AWS Asia Pacific
   (Singapore) `aws-ap-southeast-1`** (closest to India), Postgres 17.
   - With the Vercel Marketplace Neon integration, this also adds `DATABASE_URL` to the Vercel
     project automatically.
2. Apply the schema: run the whole of `apps/rupee-store/schema.sql` (Neon SQL editor, `psql`, or
   the Neon MCP `run_sql_transaction`). It is idempotent. Expected tables: `orders`,
   `order_events`, `webhook_deliveries`, `settings`.
3. Copy the **pooled** connection string (host contains `-pooler`) → this is `DATABASE_URL`.
4. Optional, for running the integration tests: create a branch called `ci-test` and use its
   connection string as `TEST_DATABASE_URL`. **Never use the production branch for tests.** The
   tests empty the tables.

### A2. Generate the two store secrets

Run each command once and keep the outputs private:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

- First output → `STORE_ADMIN_TOKEN` (the dashboard password; the merchant needs it).
- Second output → `STORE_ENCRYPTION_KEY` (never needs to leave Vercel).

### A3. Create the Vercel project

Either import the GitHub repo in the Vercel dashboard or use the CLI. Settings:

| Setting | Value |
|---|---|
| Root Directory | `apps/rupee-store` |
| Framework Preset | **Other** |
| Build Command | *(empty / none)* |
| Output Directory | `public` (already in `vercel.json`) |
| Install Command | `npm install --no-audit --no-fund` (already in `vercel.json`) |
| Node.js Version | 22.x (from `package.json` engines) |
| Production Branch | `claude/gifted-ritchie-m9zzjp`, **or** merge that branch into `main` first (owner's choice) |

Environment variables (Production, and Preview if you use previews):

| Name | Value |
|---|---|
| `DATABASE_URL` | Neon pooled connection string (A1) |
| `STORE_ADMIN_TOKEN` | from A2 |
| `STORE_ENCRYPTION_KEY` | from A2 |
| `STORE_PUBLIC_URL` | only if you add a custom domain, e.g. `https://pay.example.com` |

CLI alternative, from a checkout of the branch:

```bash
cd apps/rupee-store
```
```bash
npx vercel link
```
```bash
npx vercel env add DATABASE_URL production
```
```bash
npx vercel env add STORE_ADMIN_TOKEN production
```
```bash
npx vercel env add STORE_ENCRYPTION_KEY production
```
```bash
npx vercel deploy --prod
```

**Deployment Protection:** the production URL must be public. Customers and the gateway's
webhooks need it. In Project → Settings → Deployment Protection, keep "Vercel Authentication" on
**Standard Protection** (previews only), not "All Deployments". Always give the merchant the
**production** domain, not a per-deployment URL.

### A4. Verify the deployment

With `STORE` set to the production URL:

| Check | Expected |
|---|---|
| `GET $STORE/api/health` | `{"status":"UP","database":"ok","gatewayLinked":false}` |
| `GET $STORE/api/product` | `"ready":false,"notReadyReason":"This store is not linked to its payment gateway yet."` (normal until Part B) |
| `$STORE/` in a browser | product page with "Lucky One Rupee Pass ₹1.00" |
| `$STORE/admin.html` | asks for a token; the `STORE_ADMIN_TOKEN` opens the dashboard with a yellow "Customers cannot pay right now" banner (normal until Part B) |
| `POST $STORE/api/orders` with `Origin: https://evil.example` | `403` |
| `POST $STORE/api/webhook` with no signature | `401` |

If `/api/health` returns 503, `DATABASE_URL` is wrong or the schema wasn't applied. Check the
function logs in Vercel.

### A5. Hand over to the merchant

Send the merchant the production URL and the `STORE_ADMIN_TOKEN` over a private channel. They
continue with Part B.

### Rules for any agent continuing this work

- Read `AGENTS.md` (repo conventions), `docs/RUPEE_STORE.md` and this file first.
- **Never** create a code path that marks an order paid from a browser event, a webhook body
  alone, or by hand. Paid status must only come from `deriveOrderStatus` on an authenticated
  gateway read.
- Keep secrets out of git. Keep the `PAID`-is-final and unique-UTR rules.
- Run the checks in §8 before pushing.

---

## 5. Part B — Set up the gateway on the merchant's PC

### B1. One-command setup (Windows PowerShell)

```powershell
irm https://raw.githubusercontent.com/bhaviksiddhapura/UPI-app/claude/gifted-ritchie-m9zzjp/setup.ps1 | iex
```

It installs Node.js and the project into `C:\Users\<you>\UPI-app`, then asks for:
- the **UPI ID** that should receive money (e.g. `yourname@okhdfcbank`) and the payee name;
- the **online store address** (the Vercel production URL) and its **STORE_ADMIN_TOKEN**.

Then it:
1. Starts the gateway in a new window.
2. Links the gateway to the online store: sets the UPI ID, points the webhook at
   `<store>/api/webhook`, issues a fresh merchant key and webhook secret, and sends them to the
   store over HTTPS.
3. Installs `cloudflared` and starts `npm run observer:tunnel` in another window. That window
   creates a public `https://….trycloudflare.com` address, registers it with the store, writes
   the phone pairing page, and asks the store to re-check open orders every minute.
4. Opens the local store and the admin panel.

If it says it updated `.env` and asks for a restart, do what it says and run it again.

### B2. Manual equivalent (any OS)

```bash
git clone -b claude/gifted-ritchie-m9zzjp https://github.com/bhaviksiddhapura/UPI-app.git
```
```bash
cd UPI-app
```
```bash
npm install
```
```bash
cp .env.example .env
```
```bash
npm run dev
```

Leave that running. In a second terminal:

```bash
npm run store:configure -- --upi yourname@okhdfcbank --name "Your Name" --store-url https://<store>.vercel.app --admin-token <STORE_ADMIN_TOKEN>
```

If it reports `.env` changes, restart `npm run dev` and run the same command again. Then, in a
third terminal (needs `cloudflared`; on Windows: `winget install --id Cloudflare.cloudflared`):

```bash
npm run observer:tunnel
```

### B3. Link WhatsApp (customer sign-in OTP)

Checkout asks the customer for a WhatsApp OTP before it shows the QR.
1. Open http://localhost:6001 (admin panel).
2. Go to **Developer & Infrastructure Hub → Gmail & WhatsApp Protocols → Connect**.
3. Scan the QR with WhatsApp → **Linked devices → Link a device**.

OTPs are sent from that WhatsApp account.

### B4. Pair the observer phone

Use the Android phone that receives the credit SMS or notification for the UPI ID.

1. Copy `apps/android-observer-app/youpi-sms-gateway.apk` to the phone and install it. Compare its
   SHA-256 with `youpi-sms-gateway.apk.sha256`.
2. In the app, grant SMS and notification access. Set battery to **Unrestricted** and allow
   autostart.
3. On the PC, open `data/observer-pairing.html` (written by the tunnel window) and scan its QR in
   the app, or type the URL and token it shows.
4. Delete that file afterwards: the token lets a device report payments.
5. The admin panel's **Android SMS Hub** should show the phone as connected. Until it does, the
   store answers "UPI payments are paused: the merchant's payment phone is offline" (by design).

### B5. First live ₹1 payment

1. Open the **Vercel store URL** on any device and click **Buy now with UPI**.
2. Sign in with a mobile number and enter the WhatsApp OTP.
3. Scan the QR with a UPI app on a **different bank account** from the one receiving the money
   (most banks reject paying yourself). Pay exactly **₹1.00** before the timer ends.
4. Within seconds the phone gets the bank alert, the gateway matches it, and the store page shows
   **Payment received** with the 12-digit UTR.
5. In `https://<store>.vercel.app/admin.html`, the order turns PAID live, with an activity trail:
   `CREATED → PAYMENT_CREATED → STATUS PENDING→PAID → UTR → WEBHOOK`.

### B6. Day-to-day operation

- **Keep running while selling:** the gateway window (`npm run dev`), the tunnel window
  (`npm run observer:tunnel`), and the phone app with internet access.
- **After restarting the tunnel:** the quick-tunnel address changes. The store is updated
  automatically, but the phone must be **paired again** (B4).
- **To avoid re-pairing:** route a fixed hostname to `http://localhost:7000`, either with a named
  Cloudflare tunnel on your own domain or a static ngrok domain. Then start with:
  ```bash
  npm run observer:tunnel -- --url https://pay.yourdomain.com
  ```
- **When the PC is off:** the store shows "The payment gateway is offline right now" and takes no
  orders. Nothing is lost.

---

## 6. How a payment is confirmed (and why it's the right payment)

1. **One payer at a time per UPI ID.** The gateway gives the QR only to the session holding the
   active slot for the merchant's UPI ID (5-minute window). Others wait in a queue. So a credit of
   ₹1 can only belong to the active session.
2. **The QR is fixed by the server.** It is a `upi://pay` link to the merchant's UPI ID for exactly
   1.00, with the order as the reference. The amount comes from server-side paise; the browser
   can't change it.
3. **Signed reports.** The phone reports the credit (amount + UTR), signed with its own key
   (HMAC, 60-second replay window). The gateway attributes it: `OBSERVED_SUCCESS`.
4. **Signed webhook to the store.** The gateway sends `HMAC-SHA256(secret, "<timestamp>.<body>")`.
   The store checks the signature and timestamp, then **reads the payment back from the gateway**
   with the merchant key. It marks the order PAID only if payment id, order id, amount in paise,
   currency and method `UPI` all match. If the read fails, it answers 503 and the gateway retries.
5. **Database guarantees:**
   - `PAID` can never be undone by a late or replayed event.
   - A unique index makes one UTR pay at most one order; a second use is logged as `DUPLICATE_UTR`.
   - Status changes are conditional updates, so concurrent updates can't apply twice or out of order.
6. **Nothing gets stuck.** Lost webhooks are covered by the customer page re-checking, the
   dashboard re-checking, and the PC calling `/api/admin/sync` every minute.

**Settlement note:** `OBSERVED_SUCCESS` means "the merchant's bank alert matched". It is not a bank
statement reconciliation. For a ₹1 digital item that is a reasonable point to deliver. For
anything valuable, wait for `RECONCILED` (bank statement import in the gateway admin) or check the
bank app.

---

## 7. Security controls

| Control | Where |
|---|---|
| Price fixed on the server; client amounts ignored | `api/orders/index.js`, `src/product.js` |
| Payments created only server-side with the merchant key; anonymous creation blocked | store + gateway `YOUPI_REQUIRE_MERCHANT_KEY` |
| Webhook HMAC over timestamp + raw body, timestamp window, delivery-id dedupe; paid only after authenticated read-back | `api/webhook.js`, `src/gateway.js` |
| PAID final, unique UTR, conditional status updates, full event log | `lib/store.js`, `schema.sql` |
| Same-origin check, JSON only, atomic rate limits (3 checkouts/client/min, 20 open overall) | `api/orders/index.js`, `lib/store.js` |
| Admin endpoints: 64-hex bearer token, constant-time compare | `lib/store.js` `isAdmin` |
| Merchant key + webhook secret stored AES-256-GCM encrypted in Neon; client IPs stored only as keyed hashes | `lib/store.js` |
| Gateway link accepts only `https://` and proves the address + key work before saving | `api/admin/link.js` |
| Strict CSP (no inline script), `frame-ancestors 'none'`, `nosniff`, `no-referrer`, HSTS, `no-store` on API | `vercel.json`, `lib/store.js` |
| Gateway: published example pairing secret refused; secrets in `data/.secrets` (gitignored); services bind to 127.0.0.1 | `packages/common/src/secrets.js` |

---

## 8. Testing

From the repository root:

```bash
npm run typecheck
```
```bash
npm run store:install
```
```bash
TEST_DATABASE_URL='<Neon ci-test branch URL>' npm test --prefix apps/rupee-store
```

- Without `TEST_DATABASE_URL`, the 18 integration tests are skipped and the 10 unit tests still run.
- `npm test` at the root runs the whole project suite. It stops at
  `apps/payment-api/src/__tests__/gateway-hardening-invariants.test.js`, which has **3
  pre-existing failures that also fail on the original, unmodified code** (observer-health setup
  in that test file). Those are not caused by this work.

**Local end-to-end** (no Vercel needed):
1. Run the gateway with `npm run dev`.
2. In another terminal, set `DATABASE_URL`, `STORE_ADMIN_TOKEN` and `STORE_ENCRYPTION_KEY`, then run
   `npm run store:dev` (store on http://localhost:8888).
3. Link it with `npm run store:configure -- ... --store-url http://127.0.0.1:8888 --admin-token <token>`.
4. Use the gateway admin panel's **Payment Simulator** (Developer & Infrastructure Hub) to stand in
   for the phone. It needs `NODE_ENV` other than `production`.
5. For OTPs without WhatsApp, start the gateway with `YOUPI_EXPOSE_DEV_OTP=true` (local testing only;
   ignored in production).

---

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Store: "This store is not linked to its payment gateway yet." | Run `store:configure ... --store-url ... --admin-token ...` on the PC (B2). Also happens if `STORE_ENCRYPTION_KEY` was changed: just run it again. |
| Store: "The payment gateway is offline right now." | No public gateway address registered: start `npm run observer:tunnel`. |
| Buy → "UPI payments are paused: … phone is offline" | Observer phone not paired or no heartbeat in 5 min (B4). Check battery settings. |
| Buy → "Could not start the payment" | Gateway/tunnel down, or the key was rotated without re-linking. Restart the gateway and tunnel; re-run `store:configure`. |
| `observer:tunnel`: "The store could not reach the gateway" | The tunnel isn't routing yet (it retries) or the gateway isn't running on port 7000. |
| `store:configure` → HTTP 401 from the store | Wrong `--admin-token`. |
| Paid but the order stays "Waiting" | Check the admin panel → Android SMS Hub and Live Monitor. The bank's alert wording may not be recognised, or the alert came after the 5-minute window (late credits go to manual review). Send the alert text to a developer to extend the parser. |
| Phone app can't connect | The tunnel restarted (new address): pair again. The app only talks to `https://` addresses. |
| `npm install` fails on Windows | Make sure you're inside the `UPI-app` folder, not `C:\Windows\System32`. Use Node 22 or 24. |
| Vercel URL asks for a Vercel login | Deployment Protection is set to "All Deployments": switch it to Standard Protection (A3). |

---

## 10. Known limitations and next steps

- **Unsigned heartbeat.** The prebuilt phone app sends unsigned heartbeats. Someone who knows a
  paired device id could make the observer look online. That can't fake a payment (payment reports
  are signed), but it weakens the "observer offline → stop selling" gate. Fix: sign heartbeats in
  `ApiClient.java` and in the gateway (`pollers.routes.js`), then rebuild the APK.
- **Quick tunnel addresses change** on every restart (phone re-pairing). Use a fixed address (B6).
- **The PC must stay on** to take payments.
- **Bank alert formats:** parsing depends on the bank's alert wording. New banks may need parser
  updates (`packages/core/src/bank-sms-parser.js`, the observer app's `NotificationParser`).
- **Vercel Cron isn't used,** because Hobby plans limit cron frequency; the PC's tunnel window
  triggers `/api/admin/sync` every minute instead.
- **Experimental project:** see the notice at the top. Do not use it for high-value or high-volume
  payments.

---

## 11. Leftovers from earlier attempts (owner's first Claude/Netlify/Neon accounts)

These were created before the switch to Vercel and are **not used** by this setup. The owner can
delete them from their dashboards:
- Netlify site `one-rupee-upi-store`. Its deploy was skipped because the Netlify account had run
  out of credits.
- Neon project `one-rupee-upi-store` (`round-silence-77687197`, with a `ci-test` branch), in the
  first Neon account.
- The admin token shared in that earlier chat belongs to the abandoned Netlify site. Generate new
  secrets for Vercel (A2); don't reuse it.
