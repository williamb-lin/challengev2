// Ported from start.yaru.ai (Replit test/release-regressions.test.js). V2 reuses the same
// server.js payment/refund/delivery code and the same thank-you page, so these run unchanged.
// Dropped: the test that diffs files against V1's git history (028fd07/01370cd), which V2's
// repo doesn't have. Nothing here starts server.js, touches a database or calls the network.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { applyRefund, refundSummary, refundAmountBaht, isTestOrder, isProductionOrder } = require("../lib/refunds");
const server = fs.readFileSync("server.js", "utf8");
const thanks = fs.readFileSync("public/thank-you.html", "utf8");
const clone = value => structuredClone(value);
const base = () => ({ ref: "5W-1111111111", amount: 399000, currency: "USD", beam_env: "production",
  status: "paid", params: {}, paid_at: "2026-10-10T00:00:00Z" });
const event = (id, amount, extra = {}) => ({ referenceId: base().ref, refundId: id, chargeId: "mock-charge",
  currency: "USD", status: "SUCCEEDED", amount, transactionTime: "2026-10-10T00:00:00Z", ...extra });
function notify(order, notification) { Object.assign(order, applyRefund(order, notification)); return order; }
function between(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, `production code boundaries: ${start}`);
  return source.slice(a, b);
}
// Execute the real queue/store method bodies in a sandbox; never require/start server.js.
function backend(extra = {}) {
  const sends = [], errors = [];
  const context = vm.createContext({
    console: { log() {}, warn: value => errors.push(value) }, setTimeout() {}, runEmails() {},
    TIKTOK: { token: "mock", testCode: "" }, CURRENCY: "USD", isProductionOrder, refundSummary,
    sendTikTokPurchase: async order => { sends.push(order.ref); return { ok: true, ack: "mock" }; },
    fetch() { throw new Error("External calls forbidden in tests"); }, ...extra,
  });
  vm.runInContext(between(server, "function matchesOrder(", "// Mark an order paid once") +
    between(server, "async function confirmPaid(", "// Ask Stripe for a pending order") +
    "globalThis.api = {matchesOrder, confirmPaid, processDeliveries, purchaseDeliveryIntent};", context);
  return { ...context.api, context, sends, errors };
}
function localStore(order) {
  let rows = [clone(order)];
  const context = vm.createContext({
    read: () => clone(rows), write: next => { rows = clone(next); },
    applyRefund, fetch() { throw new Error("External calls forbidden"); },
  });
  vm.runInContext("globalThis.store = {" +
    between(server, "\n    async markPaid(ref, fields, paidAt, delivery = null) {", "\n    async list() {") +
    " async byRef(ref) { return read().find(row => row.ref === ref); }, async list() { return read(); } };", context);
  return context.store;
}

test("amounts in cents: 1000 cents = $10; small refunds never become full refunds", () => {
  const order = notify(base(), event("a", 1000));
  assert.equal(refundAmountBaht(order, order.params._refunds[0]), 10);
  notify(order, event("b", 3990));
  assert.equal(order.status, "partially_refunded");
  assert.equal(refundSummary(order).total, 4990);
});
test("partial + cumulative full refunds, replay and reverse notification order", () => {
  for (const amounts of [[1000, 398000], [398000, 1000], [199500, 199500]]) {
    const order = base();
    notify(order, event("a", amounts[0]));
    assert.equal(order.status, "partially_refunded");
    notify(order, event("b", amounts[1]));
    notify(order, event("a", amounts[0]));
    assert.equal(order.status, "refunded");
    assert.equal(refundSummary(order).total, 399000);
    assert.equal(order.params._refunds.length, 2);
  }
});
test("invalid, ambiguous, failed, pending, foreign currency and conflicting refunds flag review without changing verified status", () => {
  for (const patch of [{ amount: "1000" }, { amount: 1.2 }, { amount: 0 }, { amount: -1 },
    { amount: 400000 }, { currency: "THB" }, { status: "PENDING" }, { status: "FAILED" },
    { chargeId: "" }, { refundId: "" }, { referenceId: "wrong" }]) {
    const order = notify(base(), event("a", 1000, patch));
    assert.equal(order.status, "paid");
    assert(order.params._refund_review);
    assert.equal(refundSummary(order).total, 0);
  }
  const order = notify(base(), event("a", 1000));
  notify(order, event("a", 2000));
  assert.equal(refundSummary(order).total, 1000);
  assert.match(order.params._refund_review.reason, /Conflicting/);
  order.params._beam = { charge_id: "another-charge" };
  notify(order, event("b", 1000));
  assert.match(order.params._refund_review.entries.b.reason, /charge/);
});
test("legacy refund records use the smallest unit; incomplete legacy records are not guessed", () => {
  const order = base();
  order.params._refunds = [{ refund_id: "a", charge_id: "mock-charge", amount: 1000, currency: "USD" }];
  assert.equal(refundSummary(order).total, 1000);
  assert.equal(refundSummary(order).status, "partially_refunded");
  order.params._refunds[0].currency = undefined;
  assert(refundSummary(order).review.length);
  assert.equal(refundAmountBaht(order, order.params._refunds[0]), null);
});
test("valid retry resolves its review flag; unrelated review is retained", () => {
  const order = notify(base(), event("a", "1000"));
  notify(order, event("a", 1000));
  assert.equal(order.params._refund_review, undefined);
  notify(order, event("b", "1000"));
  notify(order, event("a", 1000));
  assert(order.params._refund_review);
  notify(order, event("c", "1000"));
  notify(order, event("c", 1000));
  assert.equal(order.params._refund_review.refund_id, "b");
});

test("terminal retry failure is explicit and never silently retried as a new purchase", async () => {
  const order = base();
  order.params._delivery = { tiktok: { status: "pending", attempts: 9, next_at: "2020-01-01T00:00:00Z" } };
  let sends = 0;
  const api = backend({ sendTikTokPurchase: async () => { sends++; return { ok: false, error: "mock failure" }; } });
  const store = localStore(order);
  await api.processDeliveries(store); await api.processDeliveries(store);
  const state = (await store.byRef(order.ref)).params._delivery.tiktok;
  assert.equal(state.status, "failed"); assert.equal(state.attempts, 10); assert.equal(sends, 1);
  assert.equal(state.last_error, "mock failure");
});
test("refund-before-paid and repeated paid notifications do not revive refunded orders", async () => {
  const order = base(); order.status = "pending"; order.paid_at = null;
  const store = localStore(order), api = backend();
  await store.recordRefund(order.ref, event("a", 399000));
  await api.confirmPaid(store, await store.byRef(order.ref), "mock-late-paid");
  assert.equal((await store.byRef(order.ref)).status, "refunded");
  assert((await store.byRef(order.ref)).paid_at);
  assert.equal((await store.byRef(order.ref)).params._delivery, undefined);
});
test("paid + delivery intent persist atomically even when subsequent metadata persistence fails", async () => {
  const order = base(); order.status = "pending";
  const store = localStore(order), api = backend();
  const merge = store.mergeParams; let fail = true;
  store.mergeParams = async (...args) => { if (fail) { fail = false; throw Error("transient"); } return merge(...args); };
  await assert.rejects(api.confirmPaid(store, order, "mock-paid"), /transient/);
  let saved = await store.byRef(order.ref);
  assert.equal(saved.status, "paid");
  assert.equal(saved.params._delivery.tiktok.status, "pending");
  const queuedAt = saved.params._delivery.tiktok.queued_at;
  await api.confirmPaid(store, saved, "mock-retry");
  saved = await store.byRef(order.ref);
  assert.equal(saved.params._delivery.tiktok.queued_at, queuedAt);
});
test("paid persistence failure leaves order pending; retry creates exactly one intent", async () => {
  const order = base(); order.status = "pending";
  const store = localStore(order), mark = store.markPaid, api = backend(); let fail = true;
  store.markPaid = async (...args) => { if (fail) { fail = false; throw Error("transient"); } return mark(...args); };
  await assert.rejects(api.confirmPaid(store, order, "mock"), /transient/);
  assert.equal((await store.byRef(order.ref)).status, "pending");
  await api.confirmPaid(store, order, "mock-retry");
  assert.equal((await store.byRef(order.ref)).params._delivery.tiktok.status, "pending");
});
test("delivery-result persistence failure retains leased pending intent and recovers on a later sweep with SAME event ID", async () => {
  const order = base();
  order.params._delivery = { tiktok: { status: "pending", attempts: 0, next_at: "2020-01-01T00:00:00Z" } };
  const store = localStore(order), set = store.setDelivery, api = backend(); let fail = true;
  store.setDelivery = async (...args) => { if (fail) { fail = false; throw Error("transient"); } return set(...args); };
  await api.processDeliveries(store);
  assert.equal((await store.byRef(order.ref)).params._delivery.tiktok.status, "pending");
  assert(api.errors.some(value => /retained/.test(value)));
  await api.processDeliveries(store); assert.equal(api.sends.length, 1); // active lease
  const state = (await store.byRef(order.ref)).params._delivery.tiktok;
  await set(order.ref, "tiktok", { ...state, lease_until: "2020-01-01T00:00:00Z" });
  await api.processDeliveries(store);
  assert.equal((await store.byRef(order.ref)).params._delivery.tiktok.status, "sent");
  assert.deepEqual(api.sends, [order.ref, order.ref]);
});
test("failed provider delivery backs off; stale due-list claim cannot bypass next_at", async () => {
  const order = base();
  order.params._delivery = { tiktok: { status: "pending", attempts: 0, next_at: "2020-01-01T00:00:00Z" } };
  const store = localStore(order), api = backend({ sendTikTokPurchase: async () => ({ ok: false, error: "mock retryable" }) });
  await api.processDeliveries(store);
  const state = (await store.byRef(order.ref)).params._delivery.tiktok;
  assert.equal(state.attempts, 1); assert(Date.parse(state.next_at) > Date.now());
  assert.equal(await store.claimDelivery(order.ref, "tiktok", new Date().toISOString(), new Date().toISOString()), false);
});
test("pending/failed/refunded/test/store-link/consent-denied records never send purchase", async () => {
  for (const patch of [{ status: "pending" }, { status: "error" }, { status: "refunded" },
    { beam_env: "production-test" }, { beam_env: "playground" }, { beam_env: "store_link" },
    { params: { _attr: { consent: "denied" } } }]) {
    const order = { ...base(), ...patch };
    order.params._delivery = { tiktok: { status: "pending", next_at: "2020-01-01T00:00:00Z" } };
    const api = backend(), store = localStore(order);
    await api.processDeliveries(store); assert.equal(api.sends.length, 0);
  }
});
test("test identity is separate from ad eligibility and real store-link receipt", () => {
  for (const env of ["production-test", "playground", "playground-test"]) assert(isTestOrder({ beam_env: env }));
  assert.equal(isTestOrder({ beam_env: "production" }), false);
  assert.equal(isTestOrder({ beam_env: "store_link" }), false);
  assert.equal(isProductionOrder({ beam_env: "store_link" }), false);
  assert.match(server, /test: isTestOrder\(order\), track_purchase: isProductionOrder\(order\)/);
});
test("PostgreSQL paid write is atomic; refund updates use row lock/transaction; claims check due time", () => {
  const paid = between(server, "      async markPaid(", "      async mergeParams(");
  assert.match(paid, /UPDATE orders SET status = CASE[\s\S]*jsonb_build_object\('tiktok', \$3::jsonb\)/);
  assert.match(paid, /FOR UPDATE/); assert.match(paid, /BEGIN/); assert.match(paid, /ROLLBACK/);
  assert.match(server, /'next_at' <= \$4/);
});

test("PostgreSQL refund transaction serializes concurrent notifications and rolls back transient persistence failure", async () => {
  let saved = base(), tail = Promise.resolve(), failCommit = true;
  const pool = {
    async connect() {
      const previous = tail;
      let unlock;
      tail = new Promise(resolve => { unlock = resolve; });
      await previous;
      let staged = clone(saved);
      return {
        async query(sql, args) {
          if (sql === "BEGIN") return {};
          if (sql.includes("FOR UPDATE")) return { rows: [clone(staged)] };
          if (sql.startsWith("UPDATE")) {
            staged.params = JSON.parse(args[1]);
            staged.status = args[2] || staged.status;
            return {};
          }
          if (sql === "COMMIT") {
            if (failCommit) { failCommit = false; throw Error("mock commit failure"); }
            saved = clone(staged); return {};
          }
          if (sql === "ROLLBACK") { staged = clone(saved); return {}; }
          throw Error("Unexpected database query");
        },
        release() { unlock(); },
      };
    },
  };
  const context = vm.createContext({ pool, applyRefund });
  vm.runInContext("globalThis.store = {" +
    between(server, "\n      async recordRefund(", "\n      async mergeParams(") + "};", context);
  await assert.rejects(context.store.recordRefund(saved.ref, event("a", 1000)), /commit failure/);
  assert.equal(saved.params._refunds, undefined);
  assert.equal(saved.status, "paid");
  await Promise.all([context.store.recordRefund(saved.ref, event("a", 1000)),
    context.store.recordRefund(saved.ref, event("b", 398000))]);
  assert.equal(saved.params._refunds.length, 2);
  assert.equal(saved.status, "refunded");
  await context.store.recordRefund(saved.ref, event("a", 1000));
  assert.equal(saved.params._refunds.length, 2);
});

test("PostgreSQL markPaid includes intent in the same write; replay preserves original delivery", async () => {
  let saved = base(); saved.status = "pending"; saved.paid_at = null;
  let fail = true; const queries = [];
  const pool = { async query(sql, args) {
    queries.push(sql);
    if (fail) { fail = false; throw Error("mock database failure"); }
    if (["paid", "refunded", "partially_refunded"].includes(saved.status)) return { rows: [] };
    saved.status = "paid"; saved.paid_at ||= args[1];
    if (args[2] && !saved.params._delivery?.tiktok) saved.params._delivery = { tiktok: JSON.parse(args[2]) };
    return { rows: [clone(saved)] };
  } };
  const context = vm.createContext({ pool });
  vm.runInContext("globalThis.store = {" +
    between(server, "\n      async markPaid(", "\n      // Serialize refund") + "};", context);
  const intent = { status: "pending", event_id: saved.ref };
  await assert.rejects(context.store.markPaid(saved.ref, {}, "mock-time", intent), /database failure/);
  assert.equal(saved.status, "pending"); assert.equal(saved.params._delivery, undefined);
  await context.store.markPaid(saved.ref, {}, "mock-time", intent);
  await context.store.markPaid(saved.ref, {}, "later-time", { status: "pending", event_id: "different" });
  assert.equal(saved.params._delivery.tiktok.event_id, saved.ref);
  assert.equal(saved.paid_at, "mock-time");
  for (const sql of queries) assert.match(sql, /jsonb_build_object\('tiktok', \$3::jsonb\)/);
});

test("purchase intent excludes test/store-link orders and records denied consent/no token explicitly", () => {
  const api = backend();
  for (const beam_env of ["store_link", "production-test", "playground", "playground-test"]) {
    assert.equal(api.purchaseDeliveryIntent({ ...base(), beam_env }), null);
  }
  const denied = api.purchaseDeliveryIntent({ ...base(), params: { _attr: { consent: "denied" } } });
  assert.equal(denied.status, "skipped"); assert.match(denied.reason, /consent/);
  api.context.TIKTOK.token = "";
  assert.equal(api.purchaseDeliveryIntent(base()).status, "skipped");
});

test("paid checks reject incorrect provider amount/currency/reference before paid confirmation", () => {
  const api = backend(), order = base();
  assert.equal(api.matchesOrder(order, { amount: 399000, currency: "USD", referenceId: order.ref }).length, 0);
  assert.equal(api.matchesOrder(order, { amount: 399000, currency: "usd", referenceId: order.ref }).length, 0, "Stripe sends lowercase currency codes");
  for (const patch of [{ amount: 3990 }, { amount: undefined }, { currency: "THB" }, { referenceId: "wrong" }]) {
    assert(api.matchesOrder(order, { amount: 399000, currency: "USD", referenceId: order.ref, ...patch }).length);
  }
});

function browser(markers = new Map(), extra = {}) {
  const calls = [];
  const context = vm.createContext({
    order: base().ref, ORDER_RE: /^5W-[0-9A-F]{10}$/, window: { ttq: { track: () => calls.push("tiktok") } },
    localStorage: { getItem: key => markers.get(key) || null, setItem: (key, value) => markers.set(key, value) },
    gtag: () => calls.push("google"), ...extra,
  });
  vm.runInContext(between(thanks, "    var sentThisPage = {};", "    if (!ORDER_RE.test(order))"), context);
  return { track: context.trackPurchase, context, calls };
}
const receipt = (extra = {}) => ({ status: "paid", test: false, track_purchase: true, order: base().ref,
  value: 3990, currency: "USD", package: "basic", ...extra });
test("legacy markers suppress both platforms across refresh/retry", () => {
  const markers = new Map([["yaru_purchase_tracked_" + base().ref, "legacy"]]);
  for (let refresh = 0; refresh < 2; refresh++) {
    const page = browser(markers); page.track(receipt()); page.track(receipt());
    assert.deepEqual(page.calls, []);
  }
});
test("new per-platform markers survive refresh, failed SDK retries do not block other platform", () => {
  const markers = new Map(), first = browser(markers, { gtag: undefined });
  first.track(receipt()); assert.deepEqual(first.calls, ["tiktok"]);
  const next = browser(markers); next.track(receipt()); next.track(receipt());
  assert.deepEqual(next.calls, ["google"]);
  assert.deepEqual(browser(markers).calls, []);
  const refresh = browser(markers); refresh.track(receipt()); assert.deepEqual(refresh.calls, []);
});
test("throwing browser SDK leaves its marker unset and retries on the same page", () => {
  let fail = true;
  const page = browser(new Map(), { gtag: () => { if (fail) { fail = false; throw Error("mock"); } } });
  page.track(receipt()); page.track(receipt());
  assert.equal(fail, false);
  assert.equal(page.context.localStorage.getItem("yaru_purchase_google_" + base().ref) !== null, true);
  assert.deepEqual(page.calls, ["tiktok"]);
});
test("browser consent denial, test/store-link, pending/failed/refunded, wrong identity/value never emit", () => {
  const denied = browser(new Map(), { window: { yaruConsent: { ads: false } } });
  denied.track(receipt()); assert.deepEqual(denied.calls, []);
  for (const patch of [{ test: true }, { track_purchase: false }, { status: "pending" }, { status: "error" },
    { status: "partially_refunded" }, { status: "refunded" }, { order: "wrong" }, { value: 0 }, { currency: "THB" }]) {
    const page = browser(); page.track(receipt(patch)); assert.deepEqual(page.calls, []);
  }
});
test("partial and cumulative full refunds have distinct receipt states", () => {
  assert.match(thanks, /partially_refunded: "partially_refunded"/);
  assert.match(thanks, /STATES\.partially_refunded/);
});

// V2: a session's sales cut-off is enforced at the checkout AND on the payment link's expiry.
function salesRules(env = {}) {
  const context = vm.createContext({ process: { env } });
  vm.runInContext(between(server, "const CAPACITY =", "const holdsSeat =") +
    "globalThis.rules = { salesClosed, linkExpiry, SALES_CLOSE, CAPACITY };", context);
  return context.rules;
}
// English site: nothing is capped and nothing closes until the owner sets a cut-off.
const CUTOFFS = { VIP_SALES_CLOSE: "2026-11-16T19:30:00+07:00", ESSENTIAL_SALES_CLOSE: "2026-11-17T19:30:00+07:00" };
test("built-in cut-offs: VIP closes at the pre-game, Essential at the main workshop; no seat cap", () => {
  const { salesClosed, SALES_CLOSE, CAPACITY } = salesRules();
  assert.equal(new Date(SALES_CLOSE.vip).toISOString(), "2026-11-16T12:30:00.000Z", "VIP = pre-game start");
  assert.equal(new Date(SALES_CLOSE.essential).toISOString(), "2026-11-17T12:30:00.000Z", "Essential = main workshop start");
  assert.deepEqual({ ...CAPACITY }, {});
  assert.equal(salesClosed("vip", Date.parse("2026-11-01")), false);
  assert.equal(salesClosed("coaching", Date.parse("2030-01-01")), false, "coaching has no cut-off");
  const bad = salesRules({ VIP_SALES_CLOSE: "next tuesday", VIP_CAPACITY: "0" });
  assert.equal(bad.SALES_CLOSE.vip, SALES_CLOSE.vip, "unparseable override ignored"); assert.deepEqual({ ...bad.CAPACITY }, {});
});
test("checkout stops 30 minutes before a cut-off (Stripe's minimum session life) and stays closed", () => {
  const { salesClosed, SALES_CLOSE } = salesRules(CUTOFFS);
  assert.equal(SALES_CLOSE.vip, CUTOFFS.VIP_SALES_CLOSE);
  assert.equal(SALES_CLOSE.essential, CUTOFFS.ESSENTIAL_SALES_CLOSE);
  const vip = Date.parse(SALES_CLOSE.vip), margin = 30 * 60000;
  assert.equal(salesClosed("vip", vip - margin - 1000), false);
  assert.equal(salesClosed("vip", vip - margin), true);
  assert.equal(salesClosed("vip", vip), true);
  assert.equal(salesClosed("vip", vip + 60000), true);
});
test("payment links never outlive the sales cut-off", () => {
  const { linkExpiry, SALES_CLOSE } = salesRules(CUTOFFS);
  const vip = Date.parse(SALES_CLOSE.vip), ess = Date.parse(SALES_CLOSE.essential);
  assert.equal(Date.parse(linkExpiry("vip", vip - 3600000)), vip, "uncapped link made an hour before closes at the cut-off");
  assert.equal(Date.parse(linkExpiry("vip", vip - 3 * 864e5)), vip - 3 * 864e5 + 23 * 3600000, "normal 23-hour session (Stripe allows at most 24 h)");
  assert.equal(Date.parse(linkExpiry("essential", ess - 3600000)), ess, "Essential link made at 18:30 expires 19:30, not tomorrow");
  assert.equal(Date.parse(linkExpiry("coaching", vip)), vip + 23 * 3600000, "coaching keeps 23-hour sessions");
  const capped = salesRules({ ...CUTOFFS, VIP_CAPACITY: "20" });
  assert.equal(Date.parse(capped.linkExpiry("vip", vip - 3 * 3600000)), vip - 3 * 3600000 + 31 * 60000, "capped packages get 31-minute sessions (Stripe minimum is 30)");
});
