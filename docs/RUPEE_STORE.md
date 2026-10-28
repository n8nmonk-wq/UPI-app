# One Rupee Store: your own UPI payment gateway, end to end

`apps/rupee-store` is a one-page shop that sells a single ₹1 item. It takes payment through
this self-hosted gateway. The money goes straight to **your** UPI ID, and the order is marked paid
only after your own phone sees the bank credit for that exact amount.

```
Browser ──► Rupee Store (4000) ──server-to-server, merchant key──► Payment API (6100)
                │                                                     │
                │◄──────── signed webhook + authoritative re-check ───┤
                ▼                                                     │
          Checkout (7000): WhatsApp OTP sign-in, then a UPI QR for exactly ₹1.00 to your UPI ID
                                                                      │
Customer pays ₹1 in any UPI app ──► your bank ──► credit SMS/notification on YOUR phone
                                                                      │
              Observer app on your phone ──HMAC-signed, over HTTPS tunnel──┘
```

## What "confirmed" means here

There is no bank API. A payment is confirmed when the observer app on the phone that receives
your bank's credit alerts reports a credit of exactly the checkout amount while that checkout
holds the active slot for your UPI ID. Only one customer at a time is offered the QR for a given
UPI ID, so a credit can't be matched to the wrong customer. The store then:

1. receives the gateway's webhook and checks its HMAC signature, timestamp and delivery id, and
2. reads the payment back from the gateway with its merchant key. It marks the order `PAID`
   only if the payment id, order id, amount (in paise), currency and method `UPI` all match.

The gateway calls this state `OBSERVED_SUCCESS` (settlement `NOT_RECONCILED`). It becomes
`RECONCILED` only if you import a bank statement in the admin panel. For a ₹1 digital item,
`OBSERVED_SUCCESS` is a reasonable point to deliver. For anything valuable, wait for
`RECONCILED` or check your bank app.

## Setup (Windows)

Paste this into PowerShell. It installs everything, asks for your UPI ID, starts the gateway and
opens the store:

```powershell
irm https://raw.githubusercontent.com/bhaviksiddhapura/UPI-app/claude/gifted-ritchie-m9zzjp/setup.ps1 | iex
```

Manual steps, on any OS:

```bash
npm install
cp .env.example .env
npm run dev                       # leave running
npm run store:configure -- --upi yourname@okhdfcbank --name "Your Name"
```

If `store:configure` says it updated `.env`, stop `npm run dev` with Ctrl+C, start it again, and
run the same `store:configure` command a second time.

## Two things only you can do

### 1. Link WhatsApp (customer sign-in OTP)

Checkout asks the customer for a WhatsApp OTP before it shows the QR. Open the admin panel at
http://localhost:6001, then go to **Developer & Infrastructure Hub → Gmail & WhatsApp Protocols →
Connect**. Scan the QR with WhatsApp on a phone (**Linked devices → Link a device**). OTPs are sent
from that WhatsApp account.

### 2. Pair the observer phone

Use the Android phone that gets the credit SMS or notification for the UPI ID you configured.

1. Install `cloudflared` (gives the phone a free HTTPS address for your PC):
   ```bash
   winget install --id Cloudflare.cloudflared
   ```
2. In a new terminal in the project folder, start the tunnel. Keep this window open:
   ```bash
   npm run observer:tunnel
   ```
   It prints an `https://….trycloudflare.com` address and writes `data/observer-pairing.html`.
3. Install the observer app on the phone: `apps/android-observer-app/youpi-sms-gateway.apk`.
   Its SHA-256 is in `youpi-sms-gateway.apk.sha256`. Copy it over USB or Drive.
4. In the app, grant SMS and notification access. Set battery to **Unrestricted**.
5. Open `data/observer-pairing.html` on your PC and scan the QR in the app (or type the URL and
   token it shows). Delete the file afterwards: the token lets a device report payments.
6. The admin panel's **Android SMS Hub** should show the phone as connected. The store refuses new
   orders while no observer has sent a heartbeat in the last 5 minutes.

The quick-tunnel address changes every time `observer:tunnel` restarts. Pair again when it does.
For a permanent address, use a named Cloudflare tunnel with your own domain (see
`docs/DEPLOYMENT.md`).

## Hosting the store online (Vercel + Neon)

The online version of this store runs on Vercel with a Neon Postgres database, while the gateway
stays on your PC. The complete setup (architecture, Neon, Vercel, linking, going live,
troubleshooting) is in **[HANDOFF.md](../HANDOFF.md)** at the repository root.

## Your first live ₹1 payment

1. Open http://localhost:4000 and click **Buy now with UPI**.
2. Sign in with a mobile number and enter the WhatsApp OTP.
3. Scan the QR with a UPI app on a **different** bank account from the one receiving the money
   (most banks reject paying yourself). Pay exactly ₹1.00 before the timer ends.
4. Within a few seconds your phone gets the credit alert, the observer reports it, and the store
   page shows **Payment received** with the 12-digit UTR.

If the store stays on "Waiting", check **Android SMS Hub** and **Live Monitor & Slots** in the admin
panel. The usual cause is that your bank's alert wording isn't recognised, or the alert arrived
after the 5-minute window. Late credits go to manual review; they are never silently dropped.

## Security controls in this setup

| Control | Where |
|---|---|
| Price fixed on the server; client-sent amounts are ignored | `apps/rupee-store/src/server.js` |
| Payments created server-side with the merchant API key; anonymous creation blocked (`YOUPI_REQUIRE_MERCHANT_KEY=true`) | store + `payments.routes.js` |
| Webhooks: HMAC-SHA256 over `timestamp.body`, timestamp window, delivery-id dedupe | `apps/rupee-store/src/gateway.js` |
| Webhook is only a trigger: paid status comes from an authenticated read-back that must match order, amount, currency and method | `deriveOrderStatus` |
| A paid order can't be downgraded by a late or replayed event | `apps/rupee-store/src/orders.js` |
| Same-origin check, JSON-only, per-IP rate limit (5/min) on order creation | store |
| Strict CSP (no inline script), `frame-ancestors 'none'`, `nosniff`, `no-referrer` | store |
| The published example Android enrollment secret is refused; a random per-install secret is used | `packages/common/src/secrets.js` |
| Observer reports signed per device (HMAC + 60 s replay window) | gateway (existing) |
| Secrets live in `data/.secrets/` (gitignored); all services bind to 127.0.0.1 | existing + store |

Known limitation: the prebuilt observer app sends **unsigned heartbeats**. Someone who knows a
paired device's id could keep it looking "online". That only affects the observer-offline
safety gate. It cannot mark a payment as received, because payment reports are signed.
