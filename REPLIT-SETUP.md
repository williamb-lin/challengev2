# Setting up the challenge.yaru.ai V2 preview on Replit

A separate Replit app for testing V2 with Stripe's test mode. It does **not** touch
start.yaru.ai or the current challenge.yaru.ai: own app, own database, no live ad tags, no real money.

## 1. Create the app and upload the code

1. In the Yaru workspace on replit.com, create a new app (Node.js), e.g. **"Yaru Challenge V2 (English) preview"**.
   (Don't reuse the existing "Yaru Create V2" app; that's an older project.)
2. In Replit's Files panel, upload the **contents** of the `challengev2` folder (not `node_modules`) (so `server.js`, `package.json` and `.replit` sit at the top level).
3. Open the Shell and run `npm install`, then `npm test` (should say 79 pass, 0 fail).

## 2. Add a database

Tools → **Database** → create a PostgreSQL database. Replit sets `DATABASE_URL` for you.
The app creates its tables (`orders`, `settings`) on first start. Never point this preview at
start.yaru.ai's or the Thai preview's database.

## 3. Add Secrets (Tools → Secrets)

Type these into Replit yourself. Don't paste passwords or keys into chats or files.

| Secret | Value |
|---|---|
| `ADMIN_PASSWORD` | a strong password you choose: this is your /admin login |
| `AD_TAGS` | `off` (pages load without LINE/TikTok/Google tags, so tests don't reach the ad accounts) |
| `STRIPE_SECRET_KEY` | your Stripe **test-mode** secret key (`sk_test_…`) |
| `STRIPE_WEBHOOK_SECRET` | the signing secret (`whsec_…`) of the test-mode webhook (step 5) |

Leave these **unset** on the preview: `PUBLIC_BASE_URL`, `TIKTOK_ACCESS_TOKEN`, `EMAIL_ENABLED`,
`TEST_CHECKOUT_CODE`.

## 4. Run and publish

Press **Run**, then **Publish** (autoscale). You get an address like `https://<name>.replit.app`.
Open `https://<name>.replit.app/healthz` and check:
`"storage":"postgres"`, `"payments":"stripe-playground"`, `"webhook":true`, `"adTags":"off"`.

## 5. Stripe test-mode webhook

In the Stripe Dashboard (test mode) → Developers → Webhooks → Add endpoint:
`https://<name>.replit.app/api/stripe/webhook`, events `checkout.session.completed`,
`checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
`checkout.session.expired`, `refund.created`, `refund.updated`. Copy its signing secret into
`STRIPE_WEBHOOK_SECRET`, then republish.

## 6. Use /admin

- `https://<name>.replit.app/admin`: the browser asks for a login. Username: anything.
  Password: your `ADMIN_PASSWORD`.
- Orders, statuses, package totals, VIP seats box, **Download CSV**, and the read-only
  **Daily report** (`/admin/report`).
- On the preview every order is a Stripe test-mode order, so it's listed as a test: the headline
  "paid" total stays at 0 and a "Test / playground orders" line counts them. That's deliberate:
  real totals only count real money.

## 7. Test a purchase

Buy Essential and VIP with Stripe's test card 4242 4242 4242 4242 (any future date, any CVC). Check: the thank-you page shows
the receipt, /admin shows the order as paid (test), and (with `EMAIL_ENABLED=1` and
`EMAIL_TEST_ORDERS_ONLY=1` only) the English confirmation email reads correctly.

## 8. Before publishing

1. No placeholders are left on the pages.
2. Dates are built in (pre-game Mon 16 Nov, main Tue 17 Nov, post-game Wed 18 Nov, 12:30 UTC);
   `YARU_PRE_START` / `YARU_MAIN_START` / `YARU_POST_START` only override them, and once they exist `YARU_MEET_URL`,
   `YARU_VIP_MEET_URL`, `YARU_COMMUNITY_URL`. Confirmations also need `YARU_COMPANY_NAME`.
   The contact form needs `EMAIL_SMTP_USER` / `EMAIL_SMTP_PASS` (it works even while buyer emails are
   off); messages go to admin@yaru.ai unless `CONTACT_TO` is set.
3. Cut-offs are built in (VIP = pre-game start, Essential = main workshop start); `VIP_SALES_CLOSE` /
   `ESSENTIAL_SALES_CLOSE` only override them.
4. `npm test` must pass 79/79.

## Later: cut-over to challenge.yaru.ai (only when Will says "ship")

Point challenge.yaru.ai at this app (Replit → Deployments → custom domain; DNS with Joshua), set
`PUBLIC_BASE_URL=https://challenge.yaru.ai`, the live Stripe key (`sk_live_…`), add the live-mode Stripe
webhook `https://challenge.yaru.ai/api/stripe/webhook` (same events) and its signing secret, remove `AD_TAGS`,
then check /healthz and one $1 test checkout (`TEST_CHECKOUT_CODE`). Back up the current
challenge.yaru.ai first. Never touch start.yaru.ai's app for this.
