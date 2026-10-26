# challengev2: challenge.yaru.ai V2 (English, draft)

English version of the Yaru workshop funnel, built from `startv2` (start.yaru.ai V2, Thai) on
26 Oct 2026. It will replace the current challenge.yaru.ai (the old free "5-Day Challenge" page)
once Will says "ship". It is a **separate app** from start.yaru.ai: own Replit app, own database,
own Stripe webhook. Payments are **Stripe Checkout in USD** (the Thai site uses Beam in THB).

- **Offer:** its own English rounds, fully online (Google Meet). Main workshop Tue 17 Nov 2026 12:30 UTC; VIP adds a 2-hour pre-game (Mon 16 Nov) and post-game (Wed 18 Nov), 12:30–14:30 UTC. Buyers see times in their own time zone (page) or UTC with a converter link (emails, terms); Bangkok time is never shown. Contact = form on the page (`/api/contact` → admin@yaru.ai) + email; no LINE contact, no tax-invoice section. Facts and open questions: `OFFER-EN.md`.
- **Rules:** every rule from Joshua and the V1 review rounds applies. See `RULES.md` (English adaptation
  of `../yaru-v2-rules-prompt.md`).
- Font: Sukhumvit Set only (Bold titles, Text body, Thin captions). Yaru red #c62a35 / cream.
- Checkout: Stripe Checkout Sessions (cards), USD, prices server-side only in cents: Essential $180 (18000), VIP $300 (30000), coaching $9,999 (999900). Same order/paid-check/refund/tracking rules as startv2; only the provider changed.
- Tracking (ads only, not a contact channel): the same LINE tag, TikTok pixel and Google AW-18496929738 IDs as the Thai site. No new pixels.

## What changed from startv2

| Area | Change |
|---|---|
| `public/index.html` | Rewritten in English. No venue, seat counter, countdown or crossed-out prices. Timed agenda replaced by the 5 topics in order. Upsell pop-up is text-only (the Thai video is Thai and about the in-person room). About copy = the original English challenge.yaru.ai text with the challenge references removed. Unconfirmed dates are red dashed placeholders. |
| `public/thank-you.html` | English. Same server-verified states and purchase gating. |
| `public/terms.html`, `terms-of-use.html` | English drafts, pending legal review. |
| `server.js` | `SITE_URL` = https://challenge.yaru.ai. Stripe Checkout (`/v1/checkout/sessions`, form-encoded, no SDK); signed webhook `/api/stripe/webhook` (Stripe-Signature, 5-minute replay window); order-status and /admin re-check the session; refunds via `refund.created/updated` matched on the PaymentIntent. Sessions live 23 h (31 min if capped); a package stops selling 30 min before a cut-off (Stripe minimum). No Stripe key = checkout refuses (503). DB column names (`beam_env`, `payment_link_id`) kept for schema parity. **No seat cap.** Built-in cut-offs (countdown on the page counts to the main workshop): Essential = main workshop start, VIP = pre-game start; checkout stops 30 min before (Stripe minimum) and sessions expire by the cut-off. `VIP_SALES_CLOSE` / `ESSENTIAL_SALES_CLOSE` override; `VIP_CAPACITY` / `ESSENTIAL_CAPACITY` only if a cap is ever approved. |
| `lib/emails.js` | English. Main workshop start built in (Tue 17 Nov 2026 19:30 +07:00, `YARU_MAIN_START` overrides); VIP pre-game Mon 16 Nov and post-game Wed 18 Nov 19:30–21:30 built in (`YARU_PRE_START` / `YARU_POST_START` override). Reminders: pre-game and main 2 days + 2 hours before, post-game 2 hours before. Separate Meet links (`YARU_MEET_URL`, `YARU_VIP_MEET_URL`). Community link optional (`YARU_COMMUNITY_URL`). |
| `test/*` | Ported to English. `npm test`: 79 tests, all pass. |

## Placeholders

None left: all dates are filled in, and the VIP pre-game/post-game are stated as live only, not recorded.

## Tests

`npm test` (no network, no database, no real payments):
- `test/emails.test.js`: email queue and English content.
- `test/release-regressions.test.js`: backend/refund/thank-you regressions from start.yaru.ai.
- `test/http-e2e.test.js`: boots the real server against an in-test mock Stripe (signatures, mismatches, refunds, missed webhooks).
- `test/v2-brief.test.js`: copy/structure/tracking rules from `RULES.md`.

## Run locally (safe)

Never run with live tags and a mock Stripe. Use `AD_TAGS=off` and a `sk_test_` key with a mock
`STRIPE_API_BASE`, and never set `PUBLIC_BASE_URL` to a live domain while testing.

## Known gaps

- English and Thai purchases land in the same LINE/TikTok/Google conversions.
