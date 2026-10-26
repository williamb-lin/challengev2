// challenge.yaru.ai V2 — English workshop landing page with Stripe Checkout in USD
// (built from startv2, the Thai start.yaru.ai V2, which uses Beam in THB).
// Serves the static landing page from public/, turns a form submission into a Stripe
// Checkout Session, records the order, and marks it paid when Stripe confirms.
//
// Column names kept from the Thai site so the schema matches: orders.beam_env holds the payment
// mode ("production" = Stripe live key, "playground" = Stripe test key, "-test" suffix = $1 test
// checkout), orders.payment_link_id holds the Checkout Session ID, and params._beam holds the
// provider IDs (charge_id = the PaymentIntent ID, used to match refunds).
//
// Env (Replit Secrets):
//   DATABASE_URL            Postgres connection string (Replit "Database" tool sets this)
//   ADMIN_PASSWORD          password for /admin (the orders list) and /admin/orders.csv
//   STRIPE_SECRET_KEY       Stripe Dashboard → Developers → API keys (sk_test_… = test money, sk_live_… = real money)
//   STRIPE_WEBHOOK_SECRET   Stripe Dashboard → Developers → Webhooks → your endpoint's signing secret (whsec_…)
//   PUBLIC_BASE_URL         optional, e.g. https://challenge.yaru.ai — where Stripe sends buyers back
//   VIP_SALES_CLOSE, ESSENTIAL_SALES_CLOSE  optional ISO times (e.g. 2026-11-17T19:30:00+07:00) that
//                           override the built-in cut-offs (VIP = pre-game start, Essential = main start);
//                           checkout stops 30 minutes before and Stripe sessions expire by the cut-off
//   VIP_CAPACITY, ESSENTIAL_CAPACITY        optional seat caps (unset = uncapped; both packages are online)
//   TIKTOK_ACCESS_TOKEN     optional: TikTok Events API token (Events Manager → pixel → Generate access token);
//                           when set, each paid order is reported to TikTok as a Purchase from the server
//   TIKTOK_TEST_EVENT_CODE  optional: send Events API calls to TikTok's "Test events" instead of live data
//   TEST_CHECKOUT_CODE      optional: visiting /?test=<code> makes any tier a real $1 charge,
//                           for end-to-end testing; such orders are marked TEST in /admin
//   CONTACT_TO              optional: where contact-form messages go (default admin@yaru.ai; needs EMAIL_SMTP_USER/PASS)
//   DEMO_CHECKOUT           optional: "1" = shareable demo (no Stripe, no ad tags, demo notice, receipts marked test)
//   PORT                    optional, defaults to 3000
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { configFromEnv, createSmtpTransport, createEmailer } = require("./lib/emails");
const { CURRENCY, money } = require("./lib/currency");

const PORT = Number(process.env.PORT) || 3000;
const IS_DEPLOYED = process.env.REPLIT_DEPLOYMENT === "1";
const PUBLIC_DIR = path.join(__dirname, "public");
const LOCAL_FILE = path.join(__dirname, "data", "orders.local.json");

// Prices live here, never in the browser: the form only says which package.
// Amounts are in US cents (Stripe uses the smallest currency unit): 18000 = $180.
// Checkout needs STRIPE_SECRET_KEY and creates a one-off Checkout Session per order.
const PACKAGES = {
  essential: { label: "Essential", item: "Yaru Create workshop: Essential (live online)", amount: 18000 },
  vip: { label: "VIP", item: "Yaru Create workshop: VIP (live online + pre-game & post-game)", amount: 30000 },
  coaching: { label: "1:1 Coaching", item: "1:1 coaching (1 month)", amount: 999900 },
};
// Seat limits. Only packages listed in CAPACITY are capped; CAPACITY is the whole room, shared with
// other ticket platforms (Luma, Eventbrite, Meetup…). A seat is taken by:
//  - a real (non-test) order here that is paid or partially refunded, or held while its Stripe session
//    can still be paid (pending and younger than SEAT_HOLD_MS), or
//  - a seat sold on another platform, as entered on /admin ("external_seats" setting).
// Refunded, expired, cancelled and failed orders free their seat.
// Capped packages get short checkout sessions so an unfinished checkout only holds a seat briefly.
// The English rounds are online only, so nothing is capped unless a cap is set explicitly.
const CAPACITY = {};
for (const pkg of ["vip", "essential"]) {
  const cap = Number(process.env[pkg.toUpperCase() + "_CAPACITY"]);
  if (cap > 0) CAPACITY[pkg] = cap;
}
const CAPPED_LINK_MS = 31 * 60 * 1000; // Stripe sessions must live at least 30 minutes
const LINK_MS = 23 * 60 * 60 * 1000; // and at most 24 hours
const SEAT_HOLD_MS = CAPPED_LINK_MS + 5 * 60 * 1000; // a little longer than the link lives
// Sales cut-offs = session starts (Will asked for a countdown on 26 Oct; it counts to these and the
// server enforces them). Essential: the main workshop start. VIP: the pre-game start (the day before),
// since VIP buyers would otherwise miss it. VIP_SALES_CLOSE / ESSENTIAL_SALES_CLOSE (ISO) override.
// Stripe sessions must stay open at least 30 minutes, so checkout stops CLOSE_MARGIN_MS before a cut-off
// and every session expires by the cut-off: nobody can pay after a session has started.
const SALES_CLOSE = { vip: "2026-11-16T19:30:00+07:00", essential: "2026-11-17T19:30:00+07:00" };
for (const pkg of ["vip", "essential"]) {
  const v = process.env[pkg.toUpperCase() + "_SALES_CLOSE"];
  if (v && Number.isFinite(Date.parse(v))) SALES_CLOSE[pkg] = v;
}
const CLOSE_MARGIN_MS = 30 * 60 * 1000;
// The landing page shows "N people signed up for this round" (real paid orders + seats sold on other platforms)
// only once N reaches this, so an empty or tiny count is never advertised.
const SIGNUPS_SHOW_MIN = Number.isSafeInteger(Number(process.env.SIGNUPS_SHOW_MIN)) && process.env.SIGNUPS_SHOW_MIN !== ""
  ? Number(process.env.SIGNUPS_SHOW_MIN) : 5;
// Preview safety: AD_TAGS=off serves every page without the LINE, TikTok and Google tags, so a preview
// running test payments never sends page views, checkouts or leads to the live ad accounts.
// Unset (the default) = pages are served exactly as written, tags included.
// DEMO_CHECKOUT=1: shareable demo site. "Paying" skips Stripe and lands on a receipt marked as a test
// (orders saved as beam_env "demo": never real, never sent to ad platforms, never emailed). Ad tags are
// always off in demo mode, and every page shows a "demo site" notice. Refuses to run with a live Stripe key.
const DEMO = process.env.DEMO_CHECKOUT === "1";
if (DEMO && /^(sk|rk)_live_/.test(process.env.STRIPE_SECRET_KEY || "")) {
  throw new Error("DEMO_CHECKOUT=1 must not be combined with a live Stripe key");
}
const AD_TAGS_OFF = process.env.AD_TAGS === "off" || DEMO;
const DEMO_NOTICE = '<div style="background:#23170d;color:#f6f1e7;text-align:center;font:14px/1.4 Sukhumvit,Tahoma,sans-serif;padding:8px 16px">'
  + "Demo site for review: nothing is charged and sign-ups aren't real.</div>";
const demoNotice = (html) => (DEMO ? html.replace(/<body([^>]*)>/, (m) => m + DEMO_NOTICE) : html);
const stripAdTags = (html) => html
  .replace(/<!-- TAGS:START[\s\S]*?<!-- TAGS:END -->/g, "")
  .replace(/<!-- LINE Tag Base Code -->[\s\S]*?<!-- End LINE Tag Base Code -->/g, "")
  .replace(/<!-- TikTok Pixel Code Start -->[\s\S]*?<!-- TikTok Pixel Code End -->/g, "")
  .replace(/<!-- Google tag \(gtag\.js\) -->[\s\S]*?<!-- End Google tag -->/g, "")
  .replace(/<script>\s*\/\/ TikTok funnel[\s\S]*?<\/script>/g, "");
const PAGE_FILES = { "/": "index.html", "/index.html": "index.html", "/thank-you": "thank-you.html", "/thank-you.html": "thank-you.html",
  "/terms": "terms.html", "/terms/": "terms.html", "/terms.html": "terms.html",
  "/terms-of-use": "terms-of-use.html", "/terms-of-use/": "terms-of-use.html", "/terms-of-use.html": "terms-of-use.html" };
const salesClosed = (pkg, now = Date.now()) => Boolean(SALES_CLOSE[pkg]) && now >= Date.parse(SALES_CLOSE[pkg]) - CLOSE_MARGIN_MS;
// A payment link never outlives its package's sales cut-off, so nobody can pay after sales close.
const linkExpiry = (pkg, now = Date.now()) => {
  const normal = now + (CAPACITY[pkg] ? CAPPED_LINK_MS : LINK_MS);
  return new Date(SALES_CLOSE[pkg] ? Math.min(normal, Date.parse(SALES_CLOSE[pkg])) : normal).toISOString();
};
const holdsSeat = (r, pkg, envs, holdSince) => r.package === pkg && envs.includes(r.beam_env) &&
  (["paid", "partially_refunded"].includes(r.status) ||
    (r.status === "pending" && new Date(r.created_at).toISOString() > holdSince));
// Test checkouts: real Stripe payment for $1 (100 cents) instead of the tier price.
const TEST_AMOUNT = 100;
const TEST_CODE = process.env.TEST_CHECKOUT_CODE || "";
// Purchase destinations (TikTok, Google, the thank-you page's tags) only ever get real-money
// orders on the live Stripe account. $1 test orders ("production-test"), playground
// orders and store-link orders (amount not verified per order) never count as purchases.
const { isProductionOrder, isTestOrder, refundSummary, applyRefund, refundAmountBaht } = require("./lib/refunds");
// For reports: real money received (production API orders + matched store-link orders).
const isRealOrder = (r) => r.beam_env === "production" || r.beam_env === "store_link";

// Ad-click attribution kept with each order. The landing page saves the first and the latest
// ad visit (allowlisted URL parameters + timestamp) and sends both with the checkout.
// Policy: order columns (utm_source, …, ttclid) = LAST ad touch before checkout; the first
// touch is kept alongside in params._attr.first. Identifiers are stored exactly as received.
const ATTR_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "utm_id",
  "gclid", "gbraid", "wbraid", "ttclid", "ldtag_cl"];
const SAFE_VALUE = /^[^\u0000-\u001f<>"'`\\]{1,300}$/;
function cleanTouch(t) {
  if (!t || typeof t !== "object") return null;
  const out = {};
  for (const k of ATTR_KEYS) if (typeof t[k] === "string" && SAFE_VALUE.test(t[k])) out[k] = t[k];
  if (!Object.keys(out).length) return null;
  if (typeof t.ts === "string" && !isNaN(Date.parse(t.ts))) out.ts = new Date(t.ts).toISOString();
  if (typeof t.landing === "string") out.landing = t.landing.slice(0, 200);
  return out;
}

const AD_FIELDS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ttclid"];

const STRIPE = {
  secretKey: process.env.STRIPE_SECRET_KEY || "",
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
  api: process.env.STRIPE_API_BASE || "https://api.stripe.com", // override for local testing against a mock only
};
// Live key = real money ("production"); anything else = Stripe test mode ("playground", never sent to ad platforms).
STRIPE.env = STRIPE.secretKey.startsWith("sk_live_") || STRIPE.secretKey.startsWith("rk_live_") ? "production" : "playground";
STRIPE.ready = Boolean(STRIPE.secretKey);
const BEAM = { env: STRIPE.env, ready: STRIPE.ready }; // name kept for the shared seat/order code
// Orders that count toward seats: this account's real orders (not $1 "-test" ones) and store-link orders.
const SEAT_ENVS = [BEAM.env, "store_link"];
const seatHoldSince = () => new Date(Date.now() - SEAT_HOLD_MS).toISOString();

// TikTok Events API: the server reports each paid order as CompletePayment ("Purchase") with
// SHA-256-hashed email and phone. event_id = order number, the same as the browser event on
// /thank-you, so TikTok counts the purchase once.
const TIKTOK = {
  token: process.env.TIKTOK_ACCESS_TOKEN || "",
  pixel: "DB3I03JC77U04C8M6HN0",
  testCode: process.env.TIKTOK_TEST_EVENT_CODE || "",
  api: process.env.TIKTOK_API_BASE || "https://business-api.tiktok.com", // override for local testing only
};
// Links we generate (Stripe's return address, TikTok's page URL) use this domain unless
// PUBLIC_BASE_URL says otherwise. Never point this app at start.yaru.ai (the Thai site).
const SITE_URL = "https://challenge.yaru.ai";
const OLD_HOSTS = [];
function siteBase(fallback) {
  const base = (process.env.PUBLIC_BASE_URL || fallback || SITE_URL).replace(/\/+$/, "");
  try {
    if (OLD_HOSTS.includes(new URL(base).hostname)) return SITE_URL;
  } catch {}
  return base;
}
const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const toE164 = (p) => {
  const d = String(p || "").replace(/[^\d+]/g, "");
  if (!d) return "";
  if (d.startsWith("+")) return d;
  if (d.startsWith("66")) return "+" + d;
  return d.startsWith("0") ? "+66" + d.slice(1) : "+66" + d;
};
// Sends one paid order to the TikTok Events API as CompletePayment (same event name and
// event_id = order number as the browser event on /thank-you, so TikTok keeps one).
// Returns { ok, ack } or { ok: false, error }. Called only by the delivery queue below.
async function sendTikTokPurchase(order) {
  const email = String(order.email || "").trim().toLowerCase();
  const tel = toE164(order.phone);
  const attr = order.params?._attr || {};
  const ttclid = attr.last?.ttclid || attr.first?.ttclid || order.ttclid || "";
  const user = {};
  if (email) user.email = sha256(email);
  if (tel) user.phone = sha256(tel);
  if (ttclid) user.ttclid = ttclid; // Events API 2.0: data[].user.ttclid, sent as received
  const body = {
    event_source: "web",
    event_source_id: TIKTOK.pixel,
    ...(TIKTOK.testCode ? { test_event_code: TIKTOK.testCode } : {}),
    data: [{
      event: "CompletePayment",
      event_time: Math.floor(new Date(order.paid_at || Date.now()).getTime() / 1000),
      event_id: order.ref,
      user,
      properties: {
        currency: CURRENCY,
        value: Number(order.amount) / 100, // cents -> dollars, once
        contents: [{ content_id: order.package, content_type: "product", quantity: 1 }],
      },
      page: { url: `${siteBase()}/thank-you` },
    }],
  };
  try {
    const res = await fetch(`${TIKTOK.api}/open_api/v1.3/event/track/`, {
      method: "POST",
      headers: { "Access-Token": TIKTOK.token, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.code === 0) return { ok: true, ack: data.request_id || "code 0" };
    return { ok: false, error: `${res.status} ${data.code ?? ""} ${String(data.message || "").slice(0, 200)}`.trim() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}


// ---------------------------------------------------------------------------
// Storage: Postgres when DATABASE_URL is set; a local JSON file otherwise
// (local testing only — deployed instances refuse to run without Postgres,
// because Replit deployments don't keep files written at runtime).
// The old `waitlist` table, if present, is left untouched.
// ---------------------------------------------------------------------------
function createStore() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const insertOrder = (db, o) => db.query(
      `INSERT INTO orders (ref, name, email, package, amount, beam_env, utm_source, utm_medium,
                           utm_campaign, utm_content, utm_term, ttclid, params, referrer)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [o.ref, o.name, o.email, o.package, o.amount, o.beam_env, ...AD_FIELDS.map((f) => o[f]), o.params, o.referrer]
    );
    // Same rule as holdsSeat().
    const SEATS_SQL = `SELECT count(*)::int AS n FROM orders WHERE package = $1 AND beam_env = ANY($2::text[])
      AND (status IN ('paid', 'partially_refunded') OR (status = 'pending' AND created_at > $3::timestamptz))`;
    return {
      kind: "postgres",
      async init() {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS orders (
            id              SERIAL PRIMARY KEY,
            ref             TEXT NOT NULL UNIQUE,
            name            TEXT NOT NULL,
            email           TEXT NOT NULL,
            package         TEXT NOT NULL,
            amount          INTEGER NOT NULL,
            currency        TEXT NOT NULL DEFAULT 'USD',
            status          TEXT NOT NULL DEFAULT 'pending',
            beam_env        TEXT,
            payment_link_id TEXT,
            phone           TEXT,
            payment_method  TEXT,
            utm_source      TEXT, utm_medium TEXT, utm_campaign TEXT,
            utm_content     TEXT, utm_term   TEXT, ttclid       TEXT,
            params          JSONB,
            referrer        TEXT,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            paid_at         TIMESTAMPTZ
          );
          CREATE INDEX IF NOT EXISTS orders_payment_link_id ON orders (payment_link_id);
          CREATE TABLE IF NOT EXISTS settings (
            key        TEXT PRIMARY KEY,
            value      JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
        `);
      },
      async create(o) {
        await insertOrder(pool, o);
      },
      async seatsTaken(pkg, envs, holdSince) {
        const r = await pool.query(SEATS_SQL, [pkg, envs, holdSince]);
        return r.rows[0].n;
      },
      async paidCount(envs) {
        const r = await pool.query(
          "SELECT count(*)::int AS n FROM orders WHERE beam_env = ANY($1::text[]) AND status IN ('paid', 'partially_refunded')", [envs]);
        return r.rows[0].n;
      },
      async getSetting(key) {
        const r = await pool.query("SELECT value FROM settings WHERE key = $1", [key]);
        return r.rows[0] ? r.rows[0].value : null;
      },
      async setSetting(key, value) {
        await pool.query(
          `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [key, JSON.stringify(value)]
        );
      },
      // Count and insert under one per-package lock, so two buyers can't both take the last seat.
      async createWithSeat(o, { capacity, envs, holdSince }) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["yaru-seats:" + o.package]);
          const r = await client.query(SEATS_SQL, [o.package, envs, holdSince]);
          if (r.rows[0].n >= capacity) {
            await client.query("ROLLBACK");
            return false;
          }
          await insertOrder(client, o);
          await client.query("COMMIT");
          return true;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        } finally { client.release(); }
      },
      async update(ref, fields) {
        const keys = Object.keys(fields);
        await pool.query(
          `UPDATE orders SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE ref = $1`,
          [ref, ...keys.map((k) => fields[k])]
        );
      },
      async byLink(linkId) {
        const r = await pool.query("SELECT * FROM orders WHERE payment_link_id = $1", [linkId]);
        return r.rows[0] || null;
      },
      async byRef(ref) {
        const r = await pool.query("SELECT * FROM orders WHERE ref = $1", [ref]);
        return r.rows[0] || null;
      },
      // Idempotent paid transition: only one caller (webhook, retry, refresh) gets the row back.
      async markPaid(ref, fields, paidAt, delivery = null) {
        const keys = Object.keys(fields);
        const r = await pool.query(
          `UPDATE orders SET status = CASE WHEN status IN ('refunded', 'partially_refunded') THEN status ELSE 'paid' END,
             paid_at = COALESCE(paid_at, $2),
             params = CASE WHEN $3::jsonb IS NULL OR params->'_delivery'->'tiktok' IS NOT NULL
               OR status IN ('refunded', 'partially_refunded') THEN params
               ELSE COALESCE(params, '{}'::jsonb) || jsonb_build_object('_delivery',
                 COALESCE(params->'_delivery', '{}'::jsonb) || jsonb_build_object('tiktok', $3::jsonb)) END
             ${keys.map((k, i) => `, ${k} = $${i + 4}`).join("")}
           WHERE ref = $1 AND (status NOT IN ('paid', 'refunded', 'partially_refunded')
             OR (status IN ('refunded', 'partially_refunded') AND paid_at IS NULL)) RETURNING *`,
          [ref, paidAt, delivery ? JSON.stringify(delivery) : null, ...keys.map((k) => fields[k])]
        );
        return r.rows[0] || null;
      },
      // Serialize refund read/modify/write so concurrent notifications cannot lose refunds.
      async recordRefund(ref, event) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await client.query("SELECT * FROM orders WHERE ref = $1 FOR UPDATE", [ref]);
          if (result.rows[0]) {
            const change = applyRefund(result.rows[0], event);
            await client.query("UPDATE orders SET params = $2::jsonb, status = COALESCE($3, status) WHERE ref = $1",
              [ref, JSON.stringify(change.params), change.status || null]);
          }
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally { client.release(); }
      },
      async mergeParams(ref, obj) {
        await pool.query("UPDATE orders SET params = COALESCE(params, '{}'::jsonb) || $2::jsonb WHERE ref = $1", [ref, JSON.stringify(obj)]);
      },
      async setDelivery(ref, platform, state) {
        await pool.query(
          `UPDATE orders SET params = jsonb_set(COALESCE(params, '{}'::jsonb) || jsonb_build_object('_delivery', COALESCE(params->'_delivery', '{}'::jsonb)),
             ARRAY['_delivery', $2::text], $3::jsonb) WHERE ref = $1`,
          [ref, platform, JSON.stringify(state)]
        );
      },
      // Claim a due delivery for this instance (lease), so two instances don't send at once.
      async claimDelivery(ref, platform, leaseUntil, now) {
        const r = await pool.query(
          `UPDATE orders SET params = jsonb_set(params, ARRAY['_delivery', $2::text, 'lease_until'], to_jsonb($3::text))
           WHERE ref = $1 AND params->'_delivery'->$2->>'status' = 'pending'
             AND params->'_delivery'->$2->>'next_at' <= $4
             AND COALESCE(params->'_delivery'->$2->>'lease_until', '') < $4 RETURNING ref`,
          [ref, platform, leaseUntil, now]
        );
        return r.rowCount === 1;
      },
      async list() {
        const r = await pool.query("SELECT * FROM orders ORDER BY created_at DESC");
        return r.rows;
      },
    };
  }

  if (IS_DEPLOYED) {
    throw new Error("DATABASE_URL is not set. Create a PostgreSQL database in Replit before deploying.");
  }
  console.warn("[orders] DATABASE_URL not set — saving to", LOCAL_FILE, "(local testing only)");
  const read = () => (fs.existsSync(LOCAL_FILE) ? JSON.parse(fs.readFileSync(LOCAL_FILE, "utf8")) : []);
  const write = (rows) => fs.writeFileSync(LOCAL_FILE, JSON.stringify(rows, null, 2));
  const SETTINGS_FILE = path.join(path.dirname(LOCAL_FILE), "settings.local.json");
  const readSettings = () => (fs.existsSync(SETTINGS_FILE) ? JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) : {});
  return {
    kind: "local-file",
    async init() {
      fs.mkdirSync(path.dirname(LOCAL_FILE), { recursive: true });
    },
    async create(o) {
      const rows = read();
      rows.push({ id: rows.length + 1, ...o, currency: CURRENCY, status: "pending", created_at: new Date().toISOString(), paid_at: null });
      write(rows);
    },
    async seatsTaken(pkg, envs, holdSince) {
      return read().filter((r) => holdsSeat(r, pkg, envs, holdSince)).length;
    },
    async paidCount(envs) {
      return read().filter((r) => envs.includes(r.beam_env) && ["paid", "partially_refunded"].includes(r.status)).length;
    },
    async getSetting(key) {
      return readSettings()[key] ?? null;
    },
    async setSetting(key, value) {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...readSettings(), [key]: value }, null, 2));
    },
    // Synchronous read/count/write, so it can't interleave with another checkout in this process.
    async createWithSeat(o, { capacity, envs, holdSince }) {
      const rows = read();
      if (rows.filter((r) => holdsSeat(r, o.package, envs, holdSince)).length >= capacity) return false;
      rows.push({ id: rows.length + 1, ...o, currency: CURRENCY, status: "pending", created_at: new Date().toISOString(), paid_at: null });
      write(rows);
      return true;
    },
    async update(ref, fields) {
      write(read().map((r) => (r.ref === ref ? { ...r, ...fields } : r)));
    },
    async byLink(linkId) {
      return read().find((r) => r.payment_link_id === linkId) || null;
    },
    async byRef(ref) {
      return read().find((r) => r.ref === ref) || null;
    },
    async markPaid(ref, fields, paidAt, delivery = null) {
      const rows = read();
      const row = rows.find((r) => r.ref === ref && r.status !== "paid" &&
        (!["refunded", "partially_refunded"].includes(r.status) || !r.paid_at));
      if (!row) return null;
      Object.assign(row, fields, { status: ["refunded", "partially_refunded"].includes(row.status) ? row.status : "paid",
        paid_at: row.paid_at || paidAt });
      if (delivery && row.status === "paid" && !row.params?._delivery?.tiktok) {
        row.params = { ...(row.params || {}), _delivery: { ...(row.params?._delivery || {}), tiktok: delivery } };
      }
      write(rows);
      return { ...row };
    },
    async recordRefund(ref, event) {
      const rows = read();
      const row = rows.find(order => order.ref === ref);
      if (row) Object.assign(row, applyRefund(row, event));
      write(rows);
    },
    async mergeParams(ref, obj) {
      write(read().map((r) => (r.ref === ref ? { ...r, params: { ...(r.params || {}), ...obj } } : r)));
    },
    async setDelivery(ref, platform, state) {
      write(read().map((r) => (r.ref === ref
        ? { ...r, params: { ...(r.params || {}), _delivery: { ...(r.params?._delivery || {}), [platform]: state } } } : r)));
    },
    async claimDelivery(ref, platform, leaseUntil, now) {
      const rows = read();
      const d = rows.find((r) => r.ref === ref)?.params?._delivery?.[platform];
      if (!d || d.status !== "pending" || d.next_at > now || (d.lease_until || "") >= now) return false;
      d.lease_until = leaseUntil;
      write(rows);
      return true;
    },
    async list() {
      return read().reverse();
    },
  };
}

// ---------------------------------------------------------------------------
// Stripe API (form-encoded requests, no SDK)
// ---------------------------------------------------------------------------
function formEncode(obj, prefix = "", out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") formEncode(v, key, out);
    else out.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(v)));
  }
  return out;
}
async function stripeRequest(method, urlPath, body, idempotencyKey) {
  const headers = { Authorization: "Bearer " + STRIPE.secretKey };
  if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(STRIPE.api + urlPath, {
    method,
    headers,
    body: body ? formEncode(body).join("&") : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Stripe ${method} ${urlPath} -> ${res.status} ${data?.error?.code || ""} ${data?.error?.message || ""}`.trim());
    err.status = res.status;
    throw err;
  }
  return data;
}

// Stripe-Signature: "t=<unix>,v1=<hex HMAC-SHA256 of `${t}.${rawBody}` with the whsec_ secret>".
// Events older than 5 minutes are refused (replay protection).
const STRIPE_TOLERANCE_S = 300;
function validStripeSignature(rawBody, header, nowS = Math.floor(Date.now() / 1000)) {
  if (!STRIPE.webhookSecret || !header) return false;
  const parts = String(header).split(",").map((p) => p.split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!Number.isFinite(t) || !sigs.length || Math.abs(nowS - t) > STRIPE_TOLERANCE_S) return false;
  const expected = crypto.createHmac("sha256", STRIPE.webhookSecret).update(`${t}.`).update(rawBody).digest();
  return sigs.some((sig) => {
    const given = Buffer.from(sig, "hex");
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}

// A provider "paid" message only counts if it is for this exact order: same reference,
// same amount in cents (the unit we sent Stripe), USD.
function matchesOrder(order, { amount, currency, referenceId }) {
  const problems = [];
  if (Number(amount) !== Number(order.amount)) problems.push(`amount ${amount} != ${order.amount}`);
  if (String(currency || "").toUpperCase() !== CURRENCY) problems.push(`currency ${currency}`);
  if (referenceId !== undefined && referenceId !== order.ref) problems.push(`reference ${referenceId}`);
  return problems;
}

// Mark an order paid once (idempotent), record the provider IDs, reload the saved record and
// queue purchase delivery from it. Returns the saved order.
async function confirmPaid(store, order, source, extra = {}, fields = {}) {
  const prevBeam = order.params?._beam || {};
  // The paid transition and delivery intent are ONE database write. If later metadata or
  // delivery-result persistence fails, the durable pending intent survives for retry.
  const updated = await store.markPaid(order.ref, fields, extra.paidAt || new Date().toISOString(), purchaseDeliveryIntent(order));
  await store.mergeParams(order.ref, { _beam: { ...prevBeam, ...extra.beam, ...(updated ? { confirmed_by: source, confirmed_at: new Date().toISOString() } : {}) } });
  const saved = await store.byRef(order.ref);
  if (updated) {
    console.log(`[stripe] payment confirmed for ${order.ref} (${order.package}, status ${saved.status}) via ${source}`);
    if (saved.params?._delivery?.tiktok?.status === "pending") {
      setTimeout(() => processDeliveries(store).catch((e) => console.warn("[delivery]", e.message)), 16000);
    }
  }
  runEmails(store);
  return saved;
}

// ---------------------------------------------------------------------------
// Purchase delivery queue (server -> TikTok Events API). State lives on the order
// (params._delivery.tiktok): pending -> sent (TikTok answered code 0) | failed (gave up) |
// skipped (no token / consent denied) | cancelled (order no longer paid before sending).
// Retries with backoff; a lease stops two instances sending the same order at once.
// "sent" means TikTok accepted the request, not that the sale was attributed to an ad.
// ---------------------------------------------------------------------------
const DELIVERY_MAX_ATTEMPTS = 10;
function purchaseDeliveryIntent(order) {
  if (!order || !isProductionOrder(order)) return null;
  const now = new Date();
  return !TIKTOK.token
    ? { status: "skipped", reason: "TIKTOK_ACCESS_TOKEN not set" }
    : order.params?._attr?.consent === "denied"
      ? { status: "skipped", reason: "ad consent denied" }
      : { status: "pending", event: "CompletePayment", event_id: order.ref, attempts: 0, queued_at: now.toISOString(),
          // short delay so the order's phone and payment IDs are saved first
          next_at: new Date(now.getTime() + 15000).toISOString() };
}

let deliveryRunning = false;
async function processDeliveries(store) {
  if (deliveryRunning) return;
  deliveryRunning = true;
  try {
    const now = Date.now();
    const due = (await store.list()).filter((r) => {
      // Only TikTok intents belong here; email_* keys have their own queue.
      const d = r.params?._delivery?.tiktok;
      return d && d.status === "pending" && Date.parse(d.next_at || 0) <= now;
    });
    for (const r of due) {
      try {
      const nowIso = new Date().toISOString();
      if (!(await store.claimDelivery(r.ref, "tiktok", new Date(Date.now() + 5 * 60000).toISOString(), nowIso))) continue;
      const order = await store.byRef(r.ref); // reload the saved record before sending
      const st = { ...order.params._delivery.tiktok, lease_until: null };
      if (order.status !== "paid" || !isProductionOrder(order) || order.params?._attr?.consent === "denied" ||
          order.params?._refund_review || refundSummary(order).total > 0 || refundSummary(order).review.length) {
        await store.setDelivery(order.ref, "tiktok", { ...st, status: "cancelled", reason: `order is ${order.status}` });
        continue;
      }
      const result = await sendTikTokPurchase(order);
      st.attempts = (st.attempts || 0) + 1;
      st.last_attempt_at = new Date().toISOString();
      if (result.ok) {
        Object.assign(st, { status: "sent", ack: result.ack, sent_at: st.last_attempt_at, last_error: null });
        console.log(`[tiktok] purchase ${order.ref} accepted${TIKTOK.testCode ? " (test events)" : ""}`);
      } else {
        st.last_error = result.error;
        if (st.attempts >= DELIVERY_MAX_ATTEMPTS) st.status = "failed";
        else st.next_at = new Date(Date.now() + Math.min(2 ** st.attempts * 60000, 6 * 3600000)).toISOString();
        console.warn(`[tiktok] purchase ${order.ref} attempt ${st.attempts} failed: ${result.error}`);
      }
      await store.setDelivery(order.ref, "tiktok", st);
      } catch (error) {
        // Keep the durable pending record/lease intact; a later sweep retries it.
        console.warn(`[delivery] ${r.ref} persistence/delivery failure; pending intent retained: ${error.message}`);
      }
    }
  } finally {
    deliveryRunning = false;
  }
}

// Ask Stripe for a pending order's Checkout Session (backup for missed webhooks).
async function refreshFromStripe(store, order) {
  if (!STRIPE.ready || order.status !== "pending" || !order.payment_link_id || String(order.beam_env).replace(/-test$/, "") !== STRIPE.env) return;
  const session = await stripeRequest("GET", `/v1/checkout/sessions/${encodeURIComponent(order.payment_link_id)}`);
  await applySession(store, order, session, "stripe_api_refresh");
}

// Apply a Checkout Session's state to its order: paid only on an exact match; expired sessions expire the order.
async function applySession(store, order, session, source) {
  if (session.payment_status === "paid") {
    const problems = matchesOrder(order, { amount: session.amount_total, currency: session.currency, referenceId: session.client_reference_id });
    if (problems.length) {
      console.warn(`[stripe] ${source} for ${order.ref} does not match the order (${problems.join(", ")}); not marked paid`);
      await store.mergeParams(order.ref, { _beam: { ...(order.params?._beam || {}), mismatch: problems.join(", "), mismatch_at: new Date().toISOString() } });
      return order;
    }
    if (order.status === "paid") return order;
    const beam = { ...(order.params?._beam || {}), session_id: session.id, charge_id: session.payment_intent || null, paid_amount_cents: Number(session.amount_total) };
    const fields = { phone: session.customer_details?.phone || order.phone || null, payment_method: "card" };
    const saved = await confirmPaid(store, { ...order, params: { ...order.params, _beam: beam } }, source, { beam }, fields);
    Object.assign(order, saved);
  } else if (session.status === "expired" && order.status === "pending") {
    await store.update(order.ref, { status: "expired" });
    order.status = "expired";
  }
  return order;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Channel of an order = its last ad touch: click IDs first, then utm_source.
function channelOf(r) {
  const a = r.params?._attr || {};
  const t = a.last || a.first || r;
  if (t.gclid || t.gbraid || t.wbraid) return "google";
  if (t.ttclid) return "tiktok";
  if (t.ldtag_cl) return "line";
  const src = String(t.utm_source || r.utm_source || "").toLowerCase();
  return src || "direct/unknown";
}
const refundedBaht = (r) => refundSummary(r).review.length ? null : refundSummary(r).total / 100;
const refundDisplayOrder = (r) => ({ ...r, status: refundSummary(r).status || r.status });
const clip = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const baht = money; // admin pages: amounts shown in the site currency

// Naive per-IP limit so a bot can't flood checkouts: 10 per 10 min.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 10000) hits.clear();
  return recent.length > 10;
}

function checkAdmin(req, res, next) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return res.status(503).send("Admin is disabled: set ADMIN_PASSWORD in Replit Secrets.");
  const [scheme, encoded] = (req.headers.authorization || "").split(" ");
  const given = scheme === "Basic" && encoded ? Buffer.from(encoded, "base64").toString().split(":").slice(1).join(":") : "";
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  if (crypto.timingSafeEqual(a, b)) return next();
  res.set("WWW-Authenticate", 'Basic realm="Yaru 1-day course admin", charset="UTF-8"').status(401).send("Login required");
}

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Prefix cells that Excel would treat as formulas.
const csvCell = (v) => {
  let s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const fmtDate = (d) =>
  d ? new Date(d).toLocaleString("en-GB", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" }) : "";

const STATUS_COLOR = { partially_refunded: "#7a6f63", paid: "#1f7a3a", pending: "#9a6b00", expired: "#7a6f63", cancelled: "#7a6f63", refunded: "#7a6f63", error: "#c62a35" };

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
// Workshop email integration: queue failures must never affect payment responses.
const emailers = new WeakMap();
function runEmails(store) {
  return Promise.resolve().then(() => emailers.get(store)?.run())
    .catch((e) => console.warn("[email]", e?.message || "Email runner failed"));
}
function emailSummary(order) {
  return Object.entries(order.params?._delivery || {})
    .filter(([key]) => key.startsWith("email_"))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, state]) => `${key.slice(6)}:${state?.status || "unknown"}`)
    .join(", ");
}

async function main() {
  const store = createStore();
  await store.init();
  const config = configFromEnv();
  const transport = createSmtpTransport(config);
  const emailer = createEmailer({ store, config, transport });
  emailers.set(store, emailer);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  if (AD_TAGS_OFF) {
    console.log(`[pages] ${DEMO ? "DEMO_CHECKOUT=1" : "AD_TAGS=off"}: serving pages without ad tags (preview mode)`);
    app.use((req, res, next) => {
      if (req.method !== "GET" || (req.path === "/" && req.query.payment === "success")) return next();
      const isApp = /^\/(api|admin|healthz)(\/|$)/.test(req.path);
      const file = PAGE_FILES[req.path] || (!isApp && !path.extname(req.path) ? "index.html" : null); // same SPA fallback
      if (!file) return next();
      res.set("Cache-Control", "no-cache").type("html").send(demoNotice(stripAdTags(fs.readFileSync(path.join(PUBLIC_DIR, file), "utf8"))));
    });
  }

  // Stripe webhook: needs the raw body for the signature, so it's registered before express.json().
  // Subscribe the endpoint to: checkout.session.completed, checkout.session.async_payment_succeeded,
  // checkout.session.async_payment_failed, checkout.session.expired, refund.created, refund.updated.
  app.post("/api/stripe/webhook", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
    res.once("finish", () => runEmails(store));
    if (!STRIPE.webhookSecret) return res.status(503).send("Webhook secret not configured");
    if (!validStripeSignature(req.body, req.get("stripe-signature"))) return res.status(401).send("Bad signature");
    let event;
    try {
      event = JSON.parse(req.body.toString("utf8"));
    } catch {
      return res.status(400).send("Bad JSON");
    }
    const type = String(event.type || "");
    const obj = event.data?.object || {};
    try {
      if (["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.expired"].includes(type) && obj.id) {
        // The authoritative "paid": amount (cents), currency and reference must match the order.
        const order = await store.byLink(obj.id);
        if (!order) console.warn(`[stripe] ${type} for unknown session ${obj.id}`);
        else if (order.status === "paid" && obj.payment_status === "paid") console.log(`[stripe] duplicate ${type} for ${order.ref} ignored`);
        else await applySession(store, order, obj, type);
      } else if (type === "checkout.session.async_payment_failed" && obj.id) {
        const order = await store.byLink(obj.id);
        if (order?.status === "pending") await store.update(order.ref, { status: "failed" });
      } else if ((type === "refund.created" || type === "refund.updated") && obj.id && obj.payment_intent) {
        // Refunds are recorded on the order and shown in reports. Purchase events already sent
        // to ad platforms are not reversed from here. Only succeeded refunds count.
        const order = (await store.list()).find((r) => r.params?._beam?.charge_id === obj.payment_intent);
        if (!order) console.warn(`[stripe] ${type} ${obj.id} for unknown payment ${obj.payment_intent}`);
        else if (obj.status === "succeeded") {
          await store.recordRefund(order.ref, { status: "SUCCEEDED", referenceId: order.ref, currency: String(obj.currency || "").toUpperCase(),
            refundId: obj.id, chargeId: obj.payment_intent, amount: obj.amount,
            transactionTime: obj.created ? new Date(obj.created * 1000).toISOString() : undefined });
          const saved = await store.byRef(order.ref);
          console.log(`[stripe] order ${order.ref}: ${saved.params?._refund_review ? "refund requires review" : saved.status}`);
        }
      }
      res.status(200).send("ok");
      processDeliveries(store).catch((e) => console.warn("[delivery]", e.message)); // retries due now
    } catch (err) {
      console.error(`[stripe] webhook ${type} failed:`, err.message);
      res.status(500).send("error"); // Stripe retries
    }
  });

  app.use(express.json({ limit: "10kb" }));

  // Contact form → email to CONTACT_TO (default admin@yaru.ai) through the same Gmail SMTP as the
  // buyer emails. Works whenever EMAIL_SMTP_USER/PASS are set (independent of EMAIL_ENABLED, which
  // only controls buyer emails). Reply-To is the visitor, so replying in Gmail answers them.
  const contactHits = new Map();
  app.post("/api/contact", async (req, res) => {
    const now = Date.now();
    const recent = (contactHits.get(req.ip) || []).filter((t) => now - t < 10 * 60 * 1000);
    recent.push(now); contactHits.set(req.ip, recent);
    if (contactHits.size > 10000) contactHits.clear();
    if (recent.length > 5) return res.status(429).json({ message: "Too many messages" });
    const oneLine = (v, n) => clip(v, n).replace(/[\r\n]+/g, " ");
    const name = oneLine(req.body?.name, 100), email = oneLine(req.body?.email, 254).toLowerCase();
    const message = clip(req.body?.message, 2000);
    if (clip(req.body?.website, 200)) return res.json({ ok: true }); // honeypot: bots fill it, people don't see it
    if (!name || !EMAIL_RE.test(email) || !message) return res.status(400).json({ message: "Name, a valid email and a message are required" });
    if (!transport) return res.status(503).json({ message: "Contact form is not set up" });
    try {
      await transport.sendMail({ from: `"Yaru website" <${config.smtpUser}>`, to: process.env.CONTACT_TO || "admin@yaru.ai",
        replyTo: `"${name.replace(/["\\]/g, "")}" <${email}>`, subject: `Website question from ${name}`,
        text: `${message}\n\n--\nFrom: ${name} <${email}>\nSent from the contact form on ${siteBase()}` });
      console.log("[contact] message forwarded");
      res.json({ ok: true });
    } catch (err) {
      console.error("[contact] send failed:", err.message);
      res.status(502).json({ message: "Could not send" });
    }
  });

  // Seats sold on other platforms, per package, as entered on /admin.
  const externalSeats = async (pkg) => {
    const n = Number((await store.getSetting("external_seats"))?.[pkg]);
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  };
  // Capped packages take a seat as the order is saved (false = sold out). $1 tests never use or need a seat.
  const createOrder = async (order) => {
    const capacity = CAPACITY[order.package];
    if (!capacity || !SEAT_ENVS.includes(order.beam_env)) {
      await store.create(order);
      return true;
    }
    const forThisSite = capacity - (await externalSeats(order.package));
    if (forThisSite <= 0) return false;
    return store.createWithSeat(order, { capacity: forThisSite, envs: SEAT_ENVS, holdSince: seatHoldSince() });
  };

  app.post("/api/checkout", async (req, res) => {
    if (rateLimited(req.ip)) return res.status(429).json({ message: "Too many requests" });
    const name = clip(req.body?.name, 100);
    const email = clip(req.body?.email, 254).toLowerCase();
    const pkgKey = clip(req.body?.package, 20);
    const pkg = PACKAGES[pkgKey];
    if (!name || !EMAIL_RE.test(email) || !pkg) return res.status(400).json({ message: "Invalid name, email or package" });
    if (salesClosed(pkgKey)) return res.status(409).json({ message: "Sales closed", code: "closed" });

    const params = {};
    for (const [k, v] of Object.entries(req.body?.params || {}).slice(0, 30)) {
      const key = clip(k, 50);
      if (key && !key.startsWith("_")) params[key] = clip(v, 300); // "_" keys are reserved for our own data
    }
    const first = cleanTouch(req.body?.attribution?.first), last = cleanTouch(req.body?.attribution?.last);
    const consent = ["granted", "denied"].includes(req.body?.attribution?.consent) ? req.body.attribution.consent : "not_collected";
    const isTest = Boolean(TEST_CODE) && BEAM.ready && params.test === TEST_CODE;
    delete params.test; // never store the code
    const ref = "5W-" + crypto.randomBytes(5).toString("hex").toUpperCase();
    const amount = isTest ? TEST_AMOUNT : pkg.amount;
    const order = { ref, name, email, package: pkgKey, amount, beam_env: BEAM.env + (isTest ? "-test" : ""), params, referrer: clip(req.body?.referrer, 500) };
    // Columns = last ad touch (from the saved visit, or the current URL); first touch kept in params._attr.
    const touch = last || first || cleanTouch(params) || {};
    for (const f of AD_FIELDS) order[f] = touch[f] || null;
    params._attr = { policy: "columns=last_touch", first, last, consent };

    if (DEMO) {
      // Demo: no Stripe. Save a demo order as paid and send the visitor straight to the receipt.
      order.beam_env = "demo";
      try {
        if (!(await createOrder(order))) return res.status(409).json({ message: "Sold out", code: "sold_out" });
        await store.markPaid(ref, { payment_method: "demo" }, new Date().toISOString(), null);
        console.log(`[checkout] demo order ${ref} (${pkgKey})`);
        return res.json({ url: `/thank-you?tier=${pkgKey}&order=${ref}`, value: amount / 100, currency: CURRENCY });
      } catch (err) {
        console.error(`[checkout] demo order ${ref} failed:`, err.message);
        return res.status(500).json({ message: "Could not start payment" });
      }
    }
    if (!STRIPE.ready) {
      // No Stripe key: refuse. Nothing is saved or charged.
      console.error(`[checkout] refused ${pkgKey}: STRIPE_SECRET_KEY is not set`);
      return res.status(503).json({ message: "Payments are not available right now" });
    }
    const expiresAt = Date.parse(linkExpiry(pkgKey)); // ≥ 30 minutes away, because salesClosed() stops sales 30 minutes early

    const base = siteBase(`${req.protocol}://${req.get("host")}`);
    try {
      if (!(await createOrder(order))) return res.status(409).json({ message: "Sold out", code: "sold_out" });
      const link = await stripeRequest(
        "POST",
        "/v1/checkout/sessions",
        {
          mode: "payment",
          client_reference_id: ref,
          customer_email: email,
          line_items: { 0: { quantity: 1, price_data: { currency: CURRENCY.toLowerCase(), unit_amount: amount,
            product_data: { name: pkg.item + (isTest ? " (TEST $1)" : "") } } } },
          metadata: { ref, package: pkgKey },
          payment_intent_data: { metadata: { ref, package: pkgKey }, description: `Yaru Create Workshop – ${pkg.label}${isTest ? " (TEST $1)" : ""}` },
          phone_number_collection: { enabled: true },
          success_url: `${base}/thank-you?tier=${pkgKey}&order=${ref}${isTest ? "&test=1" : ""}`, // separate confirmation page; tier lets ad tags report the value
          cancel_url: `${base}/?payment=cancelled#signup`,
          expires_at: Math.floor(expiresAt / 1000),
        },
        ref
      );
      await store.update(ref, { payment_link_id: link.id });
      console.log(`[checkout] order ${ref} created (${pkgKey}, ${order.beam_env}, source: ${order.utm_source || "direct"})`);
      res.json({ url: link.url, value: amount / 100, currency: CURRENCY }); // value in dollars, for Begin checkout
    } catch (err) {
      console.error(`[checkout] order ${ref} failed:`, err.message);
      await store.update(ref, { status: "error" }).catch(() => {});
      res.status(502).json({ message: "Could not start payment" });
    }
  });

  // Payment status for the confirmation page, so ad purchase tags fire only for orders the
  // server has confirmed paid (webhook, or a direct check with Stripe here). Returns no buyer
  // details: just status, package and the amount actually charged.
  const statusChecks = new Map();
  app.get("/api/order-status", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const ref = clip(req.query.order, 20);
    if (!/^5W-[0-9A-F]{10}$/.test(ref)) return res.status(400).json({ message: "Invalid order" });
    try {
      const order = await store.byRef(ref);
      if (!order) return res.status(404).json({ message: "Not found" });
      // The redirect can beat the webhook: ask Stripe directly, at most every 5 s per order.
      if (order.status === "pending" && Date.now() - (statusChecks.get(ref) || 0) > 5000) {
        statusChecks.set(ref, Date.now());
        if (statusChecks.size > 5000) statusChecks.clear();
        await refreshFromStripe(store, order).catch((e) => console.warn("[status] refresh", ref, e.message));
      }
      // value is in dollars (amounts are stored in cents).
      const refunds = refundSummary(order);
      res.json({ order: order.ref, status: order.params?._refund_review || refunds.review.length ? "refund_review" : refunds.status || order.status,
        package: order.package, value: Number(order.amount) / 100,
        currency: order.currency || CURRENCY, test: isTestOrder(order), track_purchase: isProductionOrder(order) && !order.params?._refund_review && !refunds.review.length });
    } catch (err) {
      console.error("[status]", ref, err.message);
      res.status(500).json({ message: "error" });
    }
  });

  app.get("/admin", checkAdmin, async (_req, res) => {
    const rows = (await store.list()).map(refundDisplayOrder);
    // Catch up on payments whose webhook hasn't arrived (recent pending orders only).
    const recentPending = rows.filter((r) => r.status === "pending" && Date.now() - new Date(r.created_at) < 3 * 864e5).slice(0, 25);
    for (const r of recentPending) await refreshFromStripe(store, r).catch((e) => console.warn("[admin] refresh", r.ref, e.message));

    const paid = rows.filter((r) => r.status === "paid" && isRealOrder(r));
    const testCount = rows.filter((r) => !isRealOrder(r)).length;
    const byPackage = {};
    for (const r of paid) {
      const k = PACKAGES[r.package]?.label || r.package;
      byPackage[k] = byPackage[k] || { n: 0, sum: 0 };
      byPackage[k].n += 1;
      byPackage[k].sum += Number(r.amount);
    }
    const revenue = paid.reduce((s, r) => s + Number(r.amount), 0);
    const seatBox = (await Promise.all(Object.entries(CAPACITY).map(async ([pkg, capacity]) => {
      const site = await store.seatsTaken(pkg, SEAT_ENVS, seatHoldSince());
      const elsewhere = await externalSeats(pkg);
      return `<form method="post" action="/admin/external-seats" style="margin-top:16px;background:#fff;border:1px solid #e6dfd6;border-radius:10px;padding:14px 16px;max-width:560px">
<b>${esc(PACKAGES[pkg]?.label || pkg)} seats: ${Math.max(0, capacity - site - elsewhere)} left of ${capacity}</b>
<div class="muted">Sold or held on this site: ${site} · Sold on other platforms: ${elsewhere}</div>
<label style="display:block;margin-top:10px">Seats sold on other platforms (Luma, Eventbrite, Meetup…), total so far:
<input type="number" name="count" min="0" max="${capacity}" value="${elsewhere}" required style="width:80px;margin-left:6px;font:inherit;padding:4px 6px"></label>
<input type="hidden" name="package" value="${esc(pkg)}">
<button type="submit" style="margin-top:10px;padding:6px 14px;background:#c62a35;color:#fff;border:0;border-radius:8px;font:inherit;cursor:pointer">Save</button>
<div class="muted" style="margin-top:6px">The landing page updates within a minute. Close the listing on the other platform yourself when the room is full.</div>
</form>`;
    }))).join("");
    const mode = STRIPE.ready
      ? STRIPE.env === "production" ? "LIVE payments (Stripe)" : "TEST payments (Stripe test mode)"
      : "Payments off: STRIPE_SECRET_KEY not set";
    res.set("Cache-Control", "no-store").send(`<!doctype html><html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>1-day course orders (${paid.length} paid)</title>
<style>body{font-family:system-ui,sans-serif;margin:24px;color:#1f1a14;background:#f7f3ee}
h1{margin:0 0 4px}.muted{color:#7a6f63}table{border-collapse:collapse;width:100%;background:#fff;margin-top:16px}
th,td{padding:8px 10px;border-bottom:1px solid #e6dfd6;text-align:left;font-size:14px;vertical-align:top;white-space:nowrap}
th{background:#c62a35;color:#fff;position:sticky;top:0}a.btn{display:inline-block;margin-top:12px;padding:8px 14px;
background:#c62a35;color:#fff;border-radius:8px;text-decoration:none}.wrap{overflow-x:auto}
.mode{display:inline-block;padding:2px 10px;border-radius:999px;background:${STRIPE.env === "production" && STRIPE.ready ? "#1f7a3a" : "#9a6b00"};color:#fff;font-size:12px}</style></head><body>
<h1>Orders: ${paid.length} paid · ${esc(baht(revenue))}</h1>
<div class="muted"><span class="mode">${esc(mode)}</span> · storage: ${store.kind}</div>
<div class="muted">Paid by package: ${Object.entries(byPackage).map(([k, v]) => `${esc(k)} ${v.n} (${esc(baht(v.sum))})`).join(" · ") || "none yet"}</div>
${testCount ? `<div class="muted">Test / playground orders (not counted above): ${testCount}</div>` : ""}
<div class="muted"><a href="/admin/report">Daily report (read-only)</a></div>
${rows.some(r => r.params?._refund_review || refundSummary(r).review.length) ? '<div class="muted">Refund records require review. See refund_review in the orders CSV; uncertain values are excluded from refund totals.</div>' : ""}
<div class="muted">Not marked paid: ${rows.filter((r) => r.status !== "paid" && isRealOrder(r)).length}${BEAM.ready ? " (pending, expired, cancelled or failed)" : " (sent to Beam; with store links, check Beam Lighthouse for who actually paid)"}</div>
<a class="btn" href="/admin/orders.csv">Download CSV</a>
${seatBox}
<div class="wrap"><table><thead><tr><th>Created (Bangkok)</th><th>Status</th><th>Order</th><th>Name</th><th>Email</th><th>Phone</th><th>Package</th><th>Amount</th><th>Paid (Bangkok)</th><th>Method</th><th>utm_source</th><th>utm_campaign</th><th>Emails</th></tr></thead><tbody>
${rows.map((r) => `<tr><td>${esc(fmtDate(r.created_at))}</td><td style="color:${STATUS_COLOR[r.status] || "#1f1a14"};font-weight:600">${esc(r.status)}${!isRealOrder(r) ? ' <span style="background:#1f1a14;color:#fff;border-radius:4px;padding:1px 6px;font-size:11px">TEST</span>' : ""}</td><td>${esc(r.ref)}</td><td>${esc(r.name)}</td><td>${esc(r.email)}</td><td>${esc(r.phone)}</td><td>${esc(PACKAGES[r.package]?.label || r.package)}</td><td>${esc(baht(r.amount))}</td><td>${esc(fmtDate(r.paid_at))}</td><td>${esc(r.payment_method)}</td><td>${esc(r.utm_source)}</td><td>${esc(r.utm_campaign)}</td><td style="font-size:12px;white-space:normal">${esc(emailSummary(r))}</td></tr>`).join("\n")}
</tbody></table></div></body></html>`);
  });

  // Seats sold on other platforms. Same-origin form posts only (the admin password alone isn't enough
  // against a cross-site form, because the browser re-sends saved Basic-auth credentials).
  app.post("/admin/external-seats", checkAdmin, express.urlencoded({ extended: false, limit: "2kb" }), async (req, res) => {
    const origin = req.get("origin") || req.get("referer") || "";
    let sameOrigin = false;
    try { sameOrigin = new URL(origin).host === req.get("host"); } catch {}
    if (!sameOrigin) return res.status(403).send("Forbidden");
    const pkg = clip(req.body?.package, 20);
    const count = Number(req.body?.count);
    if (!CAPACITY[pkg] || !Number.isSafeInteger(count) || count < 0 || count > CAPACITY[pkg]) {
      return res.status(400).send("Invalid package or count");
    }
    const current = (await store.getSetting("external_seats")) || {};
    await store.setSetting("external_seats", { ...current, [pkg]: count });
    console.log(`[admin] external seats for ${pkg} set to ${count}`);
    res.redirect(303, "/admin");
  });

  app.get("/admin/orders.csv", checkAdmin, async (_req, res) => {
    const rows = (await store.list()).map(refundDisplayOrder);
    const cols = ["created_at", "status", "ref", "name", "email", "phone", "package", "amount_usd", "paid_at", "payment_method", "beam_env", "payment_link_id",
      ...AD_FIELDS, "channel", ...ATTR_KEYS.map((k) => "first_" + k), "first_touch_at", ...ATTR_KEYS.map((k) => "last_" + k), "last_touch_at",
      "consent", "beam_charge_id", "refunded_usd", "refund_review", "tiktok_server_delivery", "referrer", "emails"];
    const value = (r, c) => {
      const a = r.params?._attr || {};
      if (c === "amount_usd") return Number(r.amount) / 100;
      if (c === "created_at" || c === "paid_at") return r[c] ? new Date(r[c]).toISOString() : "";
      if (c === "channel") return channelOf(r);
      if (c.startsWith("first_") || c.startsWith("last_")) {
        const [which, ...rest] = c.split("_"); const k = rest.join("_");
        return k === "touch_at" ? a[which]?.ts || "" : a[which]?.[k] || "";
      }
      if (c === "consent") return a.consent || "";
      if (c === "beam_charge_id") return r.params?._beam?.charge_id || "";
      if (c === "refunded_usd") return refundedBaht(r) || "";
      if (c === "refund_review") return r.params?._refund_review?.reason || refundSummary(r).review.join("; ");
      if (c === "tiktok_server_delivery") return r.params?._delivery?.tiktok?.status || "";
      if (c === "emails") return emailSummary(r);
      return r[c];
    };
    const lines = [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(value(r, c))).join(","))];
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="yaru-1day-orders-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    });
    res.send("﻿" + lines.join("\r\n")); // BOM so Excel shows Thai names correctly
  });

  // Daily value-for-money report. Read-only: it never asks Stripe for updates and never sends
  // events (unlike /admin, which refreshes pending orders). Counts unique real-money orders
  // by Bangkok day and channel (last ad touch). Ad spend and each platform's own attributed
  // purchases come from the ad platforms, not from here; don't add those to these counts.
  app.get(["/admin/report", "/admin/report.csv"], checkAdmin, async (req, res) => {
    const rows = (await store.list()).map(refundDisplayOrder).filter(isRealOrder);
    const day = (d) => new Date(new Date(d).getTime() + 7 * 3600000).toISOString().slice(0, 10);
    const buckets = new Map();
    const get = (d, ch) => {
      const k = d + "|" + ch;
      if (!buckets.has(k)) buckets.set(k, { date: d, channel: ch, paid_orders: 0, revenue_usd: 0, refunds: 0, refunded_usd: 0, with_click_id: 0, with_any_source: 0 });
      return buckets.get(k);
    };
    for (const r of rows) {
      const ch = channelOf(r);
      if (["paid", "refunded", "partially_refunded"].includes(r.status) && r.paid_at) {
        const b = get(day(r.paid_at), ch);
        b.paid_orders += 1;
        b.revenue_usd += Number(r.amount) / 100;
        const a = r.params?._attr || {};
        const t = { ...(a.first || {}), ...(a.last || {}), ...r };
        if (t.gclid || t.gbraid || t.wbraid || t.ttclid || t.ldtag_cl) b.with_click_id += 1;
        if (ch !== "direct/unknown") b.with_any_source += 1;
      }
      const seenRefunds = new Set();
      for (const f of r.params?._refunds || []) {
        if (seenRefunds.has(f.refund_id) || refundAmountBaht(r, f) === null || refundSummary(r).review.length ||
            !f.at || !Number.isFinite(Date.parse(f.at))) continue;
        seenRefunds.add(f.refund_id);
        const b = get(day(f.at), ch);
        b.refunds += 1;
        b.refunded_usd += refundAmountBaht(r, f);
      }
    }
    const out = [...buckets.values()].sort((x, y) => (x.date + x.channel).localeCompare(y.date + y.channel));
    const cols = ["date", "channel", "paid_orders", "revenue_usd", "refunds", "refunded_usd", "with_any_source", "with_click_id", "spend_usd"];
    res.set("Cache-Control", "no-store");
    if (req.path.endsWith(".csv")) {
      res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="yaru-daily-report-${new Date().toISOString().slice(0, 10)}.csv"` });
      return res.send("\ufeff" + [cols.join(","), ...out.map((b) => cols.map((c) => csvCell(c === "spend_usd" ? "" : b[c])).join(","))].join("\r\n"));
    }
    res.send(`<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Daily report</title><style>body{font-family:system-ui,sans-serif;margin:24px;color:#1f1a14;background:#f7f3ee}table{border-collapse:collapse;background:#fff;margin-top:12px}
th,td{padding:6px 10px;border-bottom:1px solid #e6dfd6;text-align:left;font-size:14px}th{background:#c62a35;color:#fff}.muted{color:#7a6f63}</style></head><body>
<h1>Daily report (read-only)</h1><p class="muted">Unique real-money orders by Bangkok day (paid date) and channel (last ad touch). Test, playground and failed orders are excluded.
Spend is not known to the website: fill it in from each ad platform. Platform-attributed purchases (TikTok/Google/LINE dashboards) are separate numbers; don't add them to these.</p>
${rows.some(r => r.params?._refund_review || refundSummary(r).review.length) ? '<p class="muted">Some refund records require review; see refund_review in the orders CSV. Uncertain amounts are excluded.</p>' : ""}
<p><a href="/admin/report.csv">Download CSV</a></p>
<table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>
${out.map((b) => `<tr>${cols.map((c) => `<td>${esc(c === "spend_usd" ? "" : b[c])}</td>`).join("")}</tr>`).join("\n") || '<tr><td colspan="9">No paid orders yet</td></tr>'}
</tbody></table></body></html>`);
  });

  // Seats left and sales cut-off for the landing page. Counts only; no buyer data.
  app.get("/api/seats", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const packages = {};
      for (const pkg of new Set([...Object.keys(CAPACITY), ...Object.keys(SALES_CLOSE)])) {
        const p = { closed: salesClosed(pkg), sales_close: SALES_CLOSE[pkg] || null,
          last_order: SALES_CLOSE[pkg] ? new Date(Date.parse(SALES_CLOSE[pkg]) - CLOSE_MARGIN_MS).toISOString() : null };
        if (CAPACITY[pkg]) {
          const taken = (await store.seatsTaken(pkg, SEAT_ENVS, seatHoldSince())) + (await externalSeats(pkg));
          Object.assign(p, { capacity: CAPACITY[pkg], left: Math.max(0, CAPACITY[pkg] - taken) });
        }
        packages[pkg] = p;
      }
      let elsewhere = 0;
      for (const pkg of Object.keys(CAPACITY)) elsewhere += await externalSeats(pkg);
      const total = (await store.paidCount(SEAT_ENVS)) + elsewhere;
      res.json({ now: new Date().toISOString(), packages, signups: { total, show_min: SIGNUPS_SHOW_MIN } });
    } catch (err) {
      console.error("[seats]", err.message);
      res.status(500).json({ message: "error" });
    }
  });

  app.get("/healthz", (_req, res) =>
    res.json({ ok: true, storage: store.kind, payments: DEMO ? "demo" : STRIPE.ready ? `stripe-${STRIPE.env}` : "off", webhook: Boolean(STRIPE.webhookSecret), tiktokEventsApi: Boolean(TIKTOK.token), adTags: AD_TAGS_OFF ? "off" : "on", email: emailer.status() })
  );

  // Public terms are standalone; both URL forms serve the same document.
  app.get(["/terms", "/terms/"], (_req, res) => {
    res.set("Cache-Control", "no-cache").sendFile(path.join(PUBLIC_DIR, "terms.html"));
  });
  // Website terms of use (separate from the purchase terms above).
  app.get(["/terms-of-use", "/terms-of-use/"], (_req, res) => {
    res.set("Cache-Control", "no-cache").sendFile(path.join(PUBLIC_DIR, "terms-of-use.html"));
  });

  // The confirmation page is its own standalone file (public/thank-you.html), not part of
  // the landing page. Ad platforms' purchase tags go there. Old return links that pointed
  // at the landing page (/?payment=success&…) are forwarded to it with their query.
  app.get("/thank-you", (_req, res) => {
    res.set("Cache-Control", "no-cache").sendFile(path.join(PUBLIC_DIR, "thank-you.html"));
  });
  app.get("/", (req, res, next) => {
    if (req.query.payment !== "success") return next();
    const { payment, ...rest } = req.query;
    const qs = new URLSearchParams(rest).toString();
    res.redirect(302, "/thank-you" + (qs ? "?" + qs : ""));
  });

  app.use(express.static(PUBLIC_DIR, {
    setHeaders(res, file) {
      if (file.endsWith(".html")) res.set("Cache-Control", "no-cache");
    },
  }));
  // Single-page app: unknown paths get the landing page.
  app.get("*", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

  // Purchase delivery queue: on start (catches up after a restart) and every minute.
  processDeliveries(store).catch((e) => console.warn("[delivery]", e.message));
  setInterval(() => processDeliveries(store).catch((e) => console.warn("[delivery]", e.message)), 60000);
  runEmails(store);
  setInterval(() => runEmails(store), 5 * 60000);

  app.listen(PORT, "0.0.0.0", () =>
    console.log(`[challengev2] listening on :${PORT} (storage: ${store.kind}, stripe: ${STRIPE.ready ? STRIPE.env : "not configured"})`)
  );
}

main().catch((err) => {
  console.error("[challengev2] failed to start:", err);
  process.exit(1);
});
