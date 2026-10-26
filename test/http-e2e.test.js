// End-to-end: starts the real server.js on a free port, in a temporary copy of the app (its own
// local order file, never a real database), against an in-test mock Stripe. The webhook signing
// secret is random per run. No ad tags, no TikTok token, no SMTP: nothing leaves this machine.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const WHSEC = "whsec_" + crypto.randomBytes(24).toString("hex");
const ADMIN = "e2e-" + crypto.randomBytes(6).toString("hex");
// Stripe-Signature header for a body, as Stripe builds it.
const sign = (body, t = Math.floor(Date.now() / 1000), secret = WHSEC) =>
  `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

// Minimal Stripe Checkout Sessions API: create (form-encoded) and retrieve.
function mockStripe() {
  const sessions = new Map(), calls = [];
  let n = 0;
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push(`${req.method} ${req.url}`);
      const json = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.headers.authorization !== "Bearer sk_live_mock") return json(401, { error: { message: "bad key" } });
      if (req.method === "POST" && req.url === "/v1/checkout/sessions") {
        const f = Object.fromEntries(new URLSearchParams(body)), id = "cs_e2e_" + ++n;
        const session = { id, object: "checkout.session", status: "open", payment_status: "unpaid", form: f,
          amount_total: Number(f["line_items[0][price_data][unit_amount]"]), currency: f["line_items[0][price_data][currency]"],
          client_reference_id: f.client_reference_id, payment_intent: null, url: `https://checkout.example.test/${id}` };
        sessions.set(id, session);
        return json(200, session);
      }
      const m = req.url.match(/^\/v1\/checkout\/sessions\/(.+)$/);
      if (req.method === "GET" && m && sessions.has(m[1])) return json(200, sessions.get(m[1]));
      json(404, { error: { message: "No such session" } });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, sessions, calls, url: `http://127.0.0.1:${srv.address().port}` })));
}

async function startApp(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "challengev2-e2e-"));
  for (const f of ["server.js", "lib", "public"]) fs.cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });
  const port = 40000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: dir, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, NODE_PATH: path.join(ROOT, "node_modules"), PORT: String(port),
      STRIPE_SECRET_KEY: "sk_live_mock", STRIPE_WEBHOOK_SECRET: WHSEC, ADMIN_PASSWORD: ADMIN,
      // far-future cut-offs so these tests don't depend on today's date
      VIP_SALES_CLOSE: "2099-01-01T00:00:00+07:00", ESSENTIAL_SALES_CLOSE: "2099-01-01T00:00:00+07:00", ...env },
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(base + "/api/seats"); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  return { base, dir, child, log: () => log,
    stop: () => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const auth = { Authorization: "Basic " + Buffer.from("admin:" + ADMIN).toString("base64") };
// Each call gets its own client address: the server allows 10 checkouts per address per 10 minutes.
let ipSeq = 0;
const post = (app, body, ip = `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`) => fetch(app.base + "/api/checkout", {
  method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": ip }, body: JSON.stringify(body) });
// Essential by default: VIP is capped in this run, and only the seats test should use it up.
async function checkout(app, stripe, pkg = "essential", extra = {}) {
  const r = await post(app, { name: "E2E Buyer", email: `buyer+${crypto.randomBytes(3).toString("hex")}@example.com`, package: pkg, ...extra });
  const j = await r.json();
  if (r.status !== 200) return { status: r.status, body: j };
  const id = j.url.split("/").pop(), session = stripe.sessions.get(id);
  return { status: 200, body: j, id, session, ref: session.client_reference_id };
}
const webhook = (app, type, object, signature) => {
  const body = JSON.stringify({ id: "evt_" + crypto.randomBytes(6).toString("hex"), type, data: { object } });
  return fetch(app.base + "/api/stripe/webhook", { method: "POST",
    headers: { "Content-Type": "application/json", ...(signature === null ? {} : { "stripe-signature": signature ?? sign(body) }) }, body });
};
const status = async (app, ref) => (await fetch(`${app.base}/api/order-status?order=${ref}`)).json();
const paidSession = (c, patch = {}) => ({ id: c.id, object: "checkout.session", status: "complete", payment_status: "paid",
  amount_total: c.session.amount_total, currency: "usd", client_reference_id: c.ref, payment_intent: "pi_" + c.ref,
  customer_details: { email: "buyer@example.com", phone: "+15555550100" }, ...patch });

let stripe, app;
test.before(async () => { stripe = await mockStripe(); app = await startApp({ STRIPE_API_BASE: stripe.url, VIP_CAPACITY: "3" }); });
test.after(() => { app?.stop(); stripe?.srv.close(); });

test("checkout validation: invalid name/email/package rejected; client-sent price ignored; server prices in US cents", async () => {
  for (const body of [{ name: "", email: "a@example.com", package: "vip" }, { name: "x", email: "bad", package: "vip" },
    { name: "x", email: "a@example.com", package: "platinum" }]) {
    assert.equal((await post(app, body, "10.0.0.2")).status, 400);
  }
  const c = await checkout(app, stripe, "essential", { amount: 20, price: 1, value: 1 });
  assert.equal(c.status, 200);
  assert.equal(c.session.amount_total, 18000); assert.equal(c.session.currency, "usd");
  assert.equal(c.body.value, 180); assert.equal(c.body.currency, "USD");
  assert.equal(c.session.form.mode, "payment");
  assert.equal(c.session.form["metadata[ref]"], c.ref); assert.equal(c.session.form["payment_intent_data[metadata][ref]"], c.ref);
  assert.match(c.session.form.success_url, new RegExp(`/thank-you\\?tier=essential&order=${c.ref}$`));
  const exp = Number(c.session.form.expires_at) * 1000 - Date.now();
  assert(exp >= 30 * 60000 && exp < 24 * 3600000, "Stripe needs 30 min – 24 h");
  const v = await checkout(app, stripe, "coaching");
  assert.equal(v.session.amount_total, 999900);
});

test("webhook: missing, bad, wrong-secret and stale signatures are rejected and never mark paid", async () => {
  const c = await checkout(app, stripe);
  const body = JSON.stringify({ type: "checkout.session.completed", data: { object: paidSession(c) } });
  const send = (sig) => fetch(app.base + "/api/stripe/webhook", { method: "POST", headers: { "Content-Type": "application/json", ...(sig ? { "stripe-signature": sig } : {}) }, body });
  assert.equal((await send(null)).status, 401);
  assert.equal((await send(sign("other body"))).status, 401);
  assert.equal((await send(sign(body, undefined, "whsec_wrong"))).status, 401);
  assert.equal((await send(sign(body, Math.floor(Date.now() / 1000) - 3600))).status, 401, "replayed old event");
  assert.equal((await status(app, c.ref)).status, "pending");
});

test("webhook: wrong amount, currency, reference or unpaid status is not marked paid", async () => {
  const c = await checkout(app, stripe);
  for (const patch of [{ amount_total: 100 }, { amount_total: 17999 }, { currency: "thb" }, { client_reference_id: "5W-0000000000" }, { payment_status: "unpaid" }]) {
    assert.equal((await webhook(app, "checkout.session.completed", paidSession(c, patch))).status, 200);
    assert.equal((await status(app, c.ref)).status, "pending", JSON.stringify(patch));
  }
});

test("webhook: exact match marks paid once; duplicate and concurrent replays keep one transition", async () => {
  const c = await checkout(app, stripe);
  await Promise.all(Array.from({ length: 6 }, () => webhook(app, "checkout.session.completed", paidSession(c))));
  const s = await status(app, c.ref);
  assert.equal(s.status, "paid"); assert.equal(s.value, 180); assert.equal(s.currency, "USD");
  assert.equal(s.test, false); assert.equal(s.track_purchase, true);
  const csv = await (await fetch(app.base + "/admin/orders.csv", { headers: auth })).text();
  const rows = csv.split("\r\n").filter((l) => l.includes(c.ref));
  assert.equal(rows.length, 1);
  assert(rows[0].includes("+15555550100"), "phone saved from Stripe");
  assert.equal((app.log().match(new RegExp(`payment confirmed for ${c.ref}`, "g")) || []).length, 1);
});

test("missed webhook: order-status asks Stripe and confirms only an exact paid session; expired sessions expire", async () => {
  const c = await checkout(app, stripe);
  Object.assign(stripe.sessions.get(c.id), { status: "complete", payment_status: "paid", amount_total: 17000 });
  assert.equal((await status(app, c.ref)).status, "pending", "amount mismatch is not paid");
  const d = await checkout(app, stripe);
  Object.assign(stripe.sessions.get(d.id), { status: "complete", payment_status: "paid", payment_intent: "pi_refresh" });
  assert.equal((await status(app, d.ref)).status, "paid");
  const e = await checkout(app, stripe);
  Object.assign(stripe.sessions.get(e.id), { status: "expired" });
  assert.equal((await status(app, e.ref)).status, "expired");
});

test("refunds: partial then full; a late paid webhook cannot un-refund; unsucceeded refunds don't count", async () => {
  const c = await checkout(app, stripe);
  await webhook(app, "checkout.session.completed", paidSession(c));
  const refund = (id, amount, st = "succeeded") => ({ id, object: "refund", amount, currency: "usd", payment_intent: "pi_" + c.ref, status: st, created: Math.floor(Date.now() / 1000) });
  await webhook(app, "refund.created", refund("re_0", 18000, "pending"));
  assert.equal((await status(app, c.ref)).status, "paid", "pending refund doesn't count");
  await webhook(app, "refund.created", refund("re_1", 8000));
  assert.equal((await status(app, c.ref)).status, "partially_refunded");
  await webhook(app, "refund.updated", refund("re_1", 8000)); // replay
  await webhook(app, "refund.created", refund("re_2", 10000));
  assert.equal((await status(app, c.ref)).status, "refunded");
  await webhook(app, "checkout.session.completed", paidSession(c));
  const s = await status(app, c.ref);
  assert.equal(s.status, "refunded"); assert.equal(s.track_purchase, true);
});

test("order-status: malformed id 400, unknown 404, no buyer details in the response", async () => {
  assert.equal((await fetch(app.base + "/api/order-status?order=nope")).status, 400);
  assert.equal((await fetch(app.base + "/api/order-status?order=5W-ABCDEF0123")).status, 404);
  const c = await checkout(app, stripe);
  const s = await status(app, c.ref);
  assert.deepEqual(Object.keys(s).sort(), ["currency", "order", "package", "status", "test", "track_purchase", "value"]);
});

test("seats: capacity (when set) enforced on the server, sold out returns 409 before any Stripe session", async () => {
  const before = stripe.sessions.size;
  let ok = 0, sold = 0;
  for (let i = 0; i < 6; i++) {
    const r = await post(app, { name: "Seat", email: `seat${i}@example.com`, package: "vip" }, "10.0.1." + i);
    if (r.status === 200) ok++; else if (r.status === 409) sold++;
  }
  const seats = await (await fetch(app.base + "/api/seats")).json();
  assert.equal(seats.packages.vip.left, 0);
  assert.equal(ok + sold, 6); assert(sold > 0);
  assert.equal(stripe.sessions.size - before, ok, "no session for refused seats");
  const last = stripe.sessions.get([...stripe.sessions.keys()].at(-1));
  assert(Number(last.form.expires_at) * 1000 - Date.now() >= 30 * 60000, "capped sessions still meet Stripe's 30-minute minimum");
});

test("contact form: validates input, honeypot is silently accepted, refuses cleanly when SMTP isn't set", async () => {
  const send = (body, ip = "10.7.0.1") => fetch(app.base + "/api/contact", { method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": ip }, body: JSON.stringify(body) });
  assert.equal((await send({ name: "", email: "a@example.com", message: "hi" })).status, 400);
  assert.equal((await send({ name: "A", email: "bad", message: "hi" })).status, 400);
  assert.equal((await send({ name: "A", email: "a@example.com", message: "" })).status, 400);
  assert.equal((await send({ name: "Bot", email: "b@example.com", message: "spam", website: "x" })).status, 200);
  assert.equal((await send({ name: "A", email: "a@example.com", message: "Question" })).status, 503, "no SMTP in tests");
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await send({ name: "A", email: "a@example.com", message: "q" }, "10.7.0.9")).status);
  assert.equal(codes.at(-1), 429, "rate limited after 5 per 10 minutes");
});

test("demo mode: no Stripe call, receipt is paid but marked test, no ad tags, demo notice on every page", async () => {
  const demo = await startApp({ STRIPE_SECRET_KEY: "", DEMO_CHECKOUT: "1", STRIPE_API_BASE: stripe.url });
  try {
    const before = stripe.calls.length;
    const r = await post(demo, { name: "Demo", email: "demo@example.com", package: "vip" });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.match(j.url, /^\/thank-you\?tier=vip&order=5W-[0-9A-F]{10}$/);
    assert.equal(stripe.calls.length, before, "no Stripe calls in demo mode");
    const s = await (await fetch(demo.base + "/api/order-status?order=" + j.url.split("order=")[1])).json();
    assert.equal(s.status, "paid"); assert.equal(s.test, true); assert.equal(s.track_purchase, false); assert.equal(s.value, 300);
    for (const p of ["/", "/thank-you", "/terms"]) {
      const html = await (await fetch(demo.base + p)).text();
      assert.match(html, /Demo site for review/, p);
      assert.doesNotMatch(html, /googletagmanager|ttq\.load\(|_lt\('init'/, p);
    }
    assert.equal((await (await fetch(demo.base + "/healthz")).json()).payments, "demo");
  } finally { demo.stop(); }
  const live = await startApp({ STRIPE_SECRET_KEY: "sk_live_x", DEMO_CHECKOUT: "1" });
  try {
    assert.equal((await fetch(live.base + "/healthz").catch(() => ({ status: 0 }))).status, 0, "refuses to start with a live key");
  } finally { live.stop(); }
});

test("no Stripe key: checkout refuses with 503 and saves nothing", async () => {
  const off = await startApp({ STRIPE_SECRET_KEY: "" });
  try {
    const r = await post(off, { name: "No Key", email: "nokey@example.com", package: "essential" });
    assert.equal(r.status, 503);
    assert.equal((await (await fetch(off.base + "/healthz")).json()).payments, "off");
  } finally { off.stop(); }
});

test("admin: password required; report is read-only (no Stripe calls); CSV has attribution and delivery columns", async () => {
  for (const p of ["/admin", "/admin/orders.csv", "/admin/report", "/admin/report.csv"]) {
    assert.equal((await fetch(app.base + p)).status, 401, p);
  }
  const callsBefore = stripe.calls.length;
  assert.equal((await fetch(app.base + "/admin/report", { headers: auth })).status, 200);
  assert.equal((await fetch(app.base + "/admin/report.csv", { headers: auth })).status, 200);
  assert.equal(stripe.calls.length, callsBefore, "report must not call Stripe");
  const header = (await (await fetch(app.base + "/admin/orders.csv", { headers: auth })).text()).split("\r\n")[0];
  for (const col of ["first_utm_source", "last_utm_source", "first_touch_at", "last_touch_at", "tiktok_server_delivery", "consent"]) {
    assert(header.split(",").includes(col), col);
  }
});

test("admin external-seats form: cross-site posts refused, bad values refused", async () => {
  const form = (headers, body) => fetch(app.base + "/admin/external-seats", { method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body });
  assert.equal((await form({}, "package=vip&count=1")).status, 401);
  assert.equal((await form({ ...auth }, "package=vip&count=1")).status, 403);
  assert.equal((await form({ ...auth, Origin: "https://evil.example" }, "package=vip&count=1")).status, 403);
  assert.equal((await form({ ...auth, Origin: app.base }, "package=vip&count=99")).status, 400);
  assert.equal((await form({ ...auth, Origin: app.base }, "package=coaching&count=1")).status, 400);
});

test("rate limit: an 11th checkout from one address within 10 minutes is refused", async () => {
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await post(app, { name: "x", email: "bad", package: "vip" }, "10.8.8.8")).status);
  assert.deepEqual(codes, [...Array(10).fill(400), 429]);
});

test("compatibility routes: /?payment=success forwards to /thank-you with its query; /terms serves the terms page", async () => {
  const r = await fetch(app.base + "/?payment=success&tier=vip&order=5W-ABCDEF0123", { redirect: "manual" });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/thank-you?tier=vip&order=5W-ABCDEF0123");
  for (const p of ["/terms", "/terms/"]) {
    const t = await fetch(app.base + p);
    assert.equal(t.status, 200); assert.match(await t.text(), /Terms of Service/);
  }
  for (const p of ["/terms-of-use", "/terms-of-use/"]) {
    const t = await fetch(app.base + p);
    assert.equal(t.status, 200); assert.match(await t.text(), /<h1>Yaru Website Terms of Use<\/h1>/);
  }
});

test("sales cut-off: a package past its start time is refused with 409 'closed'", async () => {
  const closed = await startApp({ STRIPE_API_BASE: stripe.url, ESSENTIAL_SALES_CLOSE: "2020-01-01T00:00:00+07:00" });
  const soon = await startApp({ STRIPE_API_BASE: stripe.url, ESSENTIAL_SALES_CLOSE: new Date(Date.now() + 20 * 60000).toISOString() });
  try {
    const r = await post(soon, { name: "Late", email: "soon@example.com", package: "essential" });
    assert.equal(r.status, 409, "closed 30 minutes before the start"); assert.equal((await r.json()).code, "closed");
  } finally { soon.stop(); }
  try {
    const r = await post(closed, { name: "Late", email: "late@example.com", package: "essential" });
    assert.equal(r.status, 409); assert.equal((await r.json()).code, "closed");
    const seats = await (await fetch(closed.base + "/api/seats")).json();
    assert.equal(seats.packages.essential.closed, true);
    assert.equal(Date.parse(seats.packages.essential.sales_close) - Date.parse(seats.packages.essential.last_order), 30 * 60000);
  } finally { closed.stop(); }
});

test("AD_TAGS=off (preview) serves every page without LINE/TikTok/Google tags; default keeps them", async () => {
  const TAGS = /googletagmanager|ttq\.load\(|analytics\.tiktok|_lt\('init'|line-scdn|tr\.line\.me/; // the tag loaders themselves
  for (const p of ["/", "/thank-you?order=5W-ABCDEF0123", "/terms", "/terms-of-use", "/some/unknown/path"]) {
    assert.match(await (await fetch(app.base + p)).text(), TAGS, `default keeps tags: ${p}`);
  }
  const preview = await startApp({ STRIPE_API_BASE: stripe.url, AD_TAGS: "off" });
  try {
    for (const p of ["/", "/index.html", "/thank-you?tier=vip&order=5W-ABCDEF0123", "/terms", "/terms-of-use", "/some/unknown/path"]) {
      const r = await fetch(preview.base + p);
      assert.equal(r.status, 200, p);
      const html = await r.text();
      assert.doesNotMatch(html, TAGS, `no tags: ${p}`);
      assert.match(html, /<\/html>/, `full page: ${p}`);
    }
    assert.match(await (await fetch(preview.base + "/")).text(), /Build a business or/);
    assert.equal((await (await fetch(preview.base + "/healthz")).json()).adTags, "off");
    assert.equal((await fetch(preview.base + "/admin")).status, 401, "admin still protected");
    const r = await fetch(preview.base + "/?payment=success&order=5W-ABCDEF0123", { redirect: "manual" });
    assert.equal(r.status, 302, "old return links still redirect");
  } finally { preview.stop(); }
});

