// Email queue tests (English site; dates: VIP pre-game Mon 16 Nov, main Tue 17 Nov, VIP post-game Wed 18 Nov, all 19:30 Bangkok): fake store (same semantics as server.js's local store) and a fake
// transport. Nothing is ever sent for real.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createEmailer, buildEmail, EMAILS } = require("../lib/emails");

const CONFIG = { enabled: true, testOrdersOnly: false, smtpUser: "admin@yaru.ai", smtpPass: "x", replyTo: "admin@yaru.ai",
  company: "Yaru Co., Ltd.", community: "https://example.com/community",
  mainStart: "2026-11-17T12:30:00.000Z", preStart: "2026-11-16T12:30:00.000Z", postStart: "2026-11-18T12:30:00.000Z",
  meet: "", vipMeet: "", recording: "", recordingAt: null };
const order = (p) => ({ ref: "5W-AAAAAAAAA1", name: "Test Buyer", email: "buyer@example.com", package: "vip", amount: 30000,
  beam_env: "production", status: "paid", paid_at: "2026-10-12T05:00:00Z", payment_method: "card", params: {}, ...p });

function fakeStore(rows) {
  const clone = (v) => JSON.parse(JSON.stringify(v));
  let data = clone(rows);
  return {
    async list() { return clone(data); },
    async byRef(ref) { return clone(data.find((r) => r.ref === ref)); },
    async setDelivery(ref, key, state) { const r = data.find((x) => x.ref === ref); r.params._delivery = { ...(r.params._delivery || {}), [key]: state }; },
    async claimDelivery(ref, key, lease, now) {
      const d = data.find((r) => r.ref === ref)?.params?._delivery?.[key];
      if (!d || d.status !== "pending" || d.next_at > now || (d.lease_until || "") >= now) return false;
      d.lease_until = lease; return true;
    },
    rows: () => data,
  };
}
function fakeTransport(fail = 0) {
  const sent = [];
  return { sent, async sendMail(m) { if (fail-- > 0) throw new Error("mock smtp down"); sent.push(m); return { messageId: "m" + sent.length }; } };
}
const at = (s) => Date.parse(s + "+07:00");
const quiet = { log() {}, warn() {} };

test("confirmation goes out once per order, with receipt, dates, links and refund terms; no tax-invoice section", async () => {
  const store = fakeStore([order()]), tx = fakeTransport();
  const e = createEmailer({ store, config: CONFIG, transport: tx, log: quiet });
  await e.run(at("2026-10-12T12:05:00")); await e.run(at("2026-10-12T12:06:00"));
  assert.equal(tx.sent.length, 1);
  const m = tx.sent[0];
  assert.equal(m.to, "buyer@example.com"); assert.match(m.from, /admin@yaru\.ai/); assert.equal(m.replyTo, "admin@yaru.ai");
  for (const s of ["5W-AAAAAAAAA1", "$300", "Credit/debit card (Stripe)", "VIP", "Monday, 16 November 2026", "Tuesday, 17 November 2026", "Wednesday, 18 November 2026", "12:30–14:30 UTC", "12:30 UTC", "timeanddate.com/worldclock/fixedtime.html?iso=20261117T1230&p1=1440", "pre-game", "post-game",
    "example.com/community", "admin@yaru.ai", "3 days before your workshop date", "Yaru Co., Ltd.",
    "statutory consumer rights", "Will Lin", "COO, Yaru"]) assert(m.text.includes(s), s);
  assert(!/[ก-ฺเ-๛]/.test(m.text), "no Thai");
  assert(!/tax invoice/i.test(m.text), "tax-invoice section removed (Will, 26 Oct)");
  assert(!/Bangkok|GMT\+7|LINE/.test(m.text), "no Bangkok time and no LINE in buyer emails");
  assert.equal(store.rows()[0].params._delivery.email_confirm.status, "sent");
});

test("without confirmed dates the confirmation says they'll follow and no reminders are scheduled", async () => {
  const store = fakeStore([order()]), tx = fakeTransport();
  const c = { ...CONFIG, mainStart: null, preStart: null, postStart: null, meet: "https://meet.google.com/m", vipMeet: "https://meet.google.com/v" };
  const e = createEmailer({ store, config: c, transport: tx, log: quiet });
  for (const t of ["2026-10-12T12:05:00", "2026-11-16T18:00:00", "2026-11-17T18:00:00", "2026-11-30T00:00:00"]) await e.run(at(t));
  assert.equal(tx.sent.length, 1); assert(tx.sent[0].text.includes("to be confirmed"));
  assert.deepEqual(Object.keys(store.rows()[0].params._delivery), ["email_confirm"]);
});

test("Essential and VIP confirmations ask for a reply to lock in the Google Meet email", async () => {
  for (const pkg of ["essential", "vip"]) {
    const tx = fakeTransport();
    await createEmailer({ store: fakeStore([order({ package: pkg })]), config: CONFIG, transport: tx, log: quiet }).run(at("2026-10-12T12:05:00"));
    assert.match(tx.sent[0].subject, /reply to confirm/); assert(tx.sent[0].text.includes("buyer@example.com")); assert(tx.sent[0].text.includes("Google Meet"));
  }
});

test("nothing is sent when disabled, test-orders-only skips real orders, missing settings hold confirmations", async () => {
  for (const config of [{ ...CONFIG, enabled: false }, { ...CONFIG, testOrdersOnly: true }, { ...CONFIG, company: "" }]) {
    const tx = fakeTransport();
    await createEmailer({ store: fakeStore([order()]), config, transport: tx, log: quiet }).run(at("2026-10-12T12:05:00"));
    assert.equal(tx.sent.length, 0);
  }
  const tx = fakeTransport();
  await createEmailer({ store: fakeStore([order({ beam_env: "production-test", amount: 100 })]), config: { ...CONFIG, testOrdersOnly: true }, transport: tx, log: quiet }).run(at("2026-10-12T12:05:00"));
  assert.equal(tx.sent.length, 1); assert(tx.sent[0].text.includes("test order"));
});

test("unpaid, refunded, playground and other-package orders get nothing", async () => {
  for (const p of [{ status: "pending" }, { status: "refunded" }, { status: "expired" }, { beam_env: "playground" }, { email: "bad" }]) {
    const tx = fakeTransport();
    await createEmailer({ store: fakeStore([order(p)]), config: CONFIG, transport: tx, log: quiet }).run(at("2026-10-12T12:05:00"));
    assert.equal(tx.sent.length, 0, JSON.stringify(p));
  }
});

test("VIP gets pre-game, main and post-game reminders; a late buyer skips past reminders", async () => {
  const c = { ...CONFIG, meet: "https://meet.google.com/main", vipMeet: "https://meet.google.com/vip" };
  const store = fakeStore([order(), order({ ref: "5W-AAAAAAAAA2", paid_at: "2026-11-15T03:00:00Z" })]), tx = fakeTransport();
  const e = createEmailer({ store, config: c, transport: tx, log: quiet });
  for (const t of ["2026-10-12T12:05:00", "2026-11-14T19:31:00", "2026-11-15T19:31:00", "2026-11-16T17:31:00", "2026-11-17T17:31:00", "2026-11-18T17:31:00", "2026-11-19T09:00:00"]) await e.run(at(t));
  const status = (i) => Object.fromEntries(Object.entries(store.rows()[i].params._delivery).map(([k, v]) => [k, v.status]));
  assert.deepEqual(status(0), { email_confirm: "sent", email_pre_r1: "sent", email_main_r1: "sent", email_pre_final: "sent", email_main_final: "sent", email_post_final: "sent" });
  assert.deepEqual(status(1), { email_confirm: "sent", email_pre_r1: "skipped", email_main_r1: "sent", email_pre_final: "sent", email_main_final: "sent", email_post_final: "sent" });
  assert.equal(tx.sent.length, 6 + 5);
  assert(tx.sent.some((m) => /pre-game/.test(m.subject) && m.text.includes("meet.google.com/vip")));
  assert(tx.sent.some((m) => /post-game/.test(m.subject) && m.text.includes("meet.google.com/vip")));
});

test("main reminders wait for the Meet link; recording goes to VIP + Essential only once the link is set", async () => {
  const rows = [order({ package: "essential", amount: 18000 }), order({ ref: "5W-AAAAAAAAA2" }), order({ ref: "5W-AAAAAAAAA3", package: "coaching", amount: 999900 })];
  const store = fakeStore(rows), tx = fakeTransport();
  await createEmailer({ store, config: CONFIG, transport: tx, log: quiet }).run(at("2026-11-15T19:35:00"));
  assert.equal(store.rows()[0].params._delivery.email_main_r1, undefined); // waiting for YARU_MEET_URL
  await createEmailer({ store, config: { ...CONFIG, meet: "https://meet.google.com/mock" }, transport: tx, log: quiet }).run(at("2026-11-15T19:36:00"));
  assert.equal(store.rows()[0].params._delivery.email_main_r1.status, "sent");
  assert(tx.sent.at(-1).text.includes("meet.google.com/mock"));
  const before = tx.sent.length;
  const withRec = { ...CONFIG, recording: "https://example.com/rec", recordingAt: new Date(at("2026-11-18T10:00:00")).toISOString() };
  await createEmailer({ store, config: withRec, transport: tx, log: quiet }).run(at("2026-11-18T10:01:00"));
  const rec = tx.sent.slice(before).filter((m) => /recording/.test(m.subject));
  assert.equal(rec.length, 2); // VIP + Essential, not coaching
});

test("SMTP failure is retried with backoff and never double-sends", async () => {
  const store = fakeStore([order()]), tx = fakeTransport(1);
  const e = createEmailer({ store, config: CONFIG, transport: tx, log: quiet });
  await e.run(at("2026-10-12T12:05:00"));
  let d = store.rows()[0].params._delivery.email_confirm;
  assert.equal(d.status, "pending"); assert.equal(d.attempts, 1); assert.match(d.last_error, /mock smtp down/);
  await e.run(at("2026-10-12T12:05:30")); assert.equal(tx.sent.length, 0); // still backing off
  d.next_at = "2020-01-01T00:00:00Z"; store.rows()[0].params._delivery.email_confirm.next_at = d.next_at;
  await e.run(Date.now()); assert.equal(tx.sent.length, 1);
  assert.equal(store.rows()[0].params._delivery.email_confirm.status, "sent");
});

test("every email renders for every package it applies to", () => {
  const c = { ...CONFIG, meet: "https://meet.google.com/x", vipMeet: "https://meet.google.com/y", recording: "https://r", };
  for (const spec of EMAILS) for (const pkg of spec.packages) {
    const m = buildEmail(spec.id, order({ package: pkg }), c);
    assert(m.subject && m.text.includes("Will Lin") && m.html.includes("<a "), `${spec.id}/${pkg}`);
  }
});
