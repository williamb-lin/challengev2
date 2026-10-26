// Workshop emails to buyers (English site): confirmation + receipt, reminders, recording link.
// Sent from admin@yaru.ai (Google Workspace SMTP with an app password), signed by Will Lin.
//
// Each email is a delivery on the order (params._delivery["email_<id>"]), using the same
// store methods as the TikTok queue: created when due, claimed with a lease (so two server
// instances never send the same email), sent once, retried with backoff on failure.
//
// Env (Replit Secrets):
//   EMAIL_ENABLED=1            master switch; nothing is sent without it
//   EMAIL_TEST_ORDERS_ONLY=1   optional: only send for $1 test orders (for a first live test)
//   EMAIL_SMTP_USER            admin@yaru.ai
//   EMAIL_SMTP_PASS            Google app password for that account (secret)
//   EMAIL_REPLY_TO             optional, defaults to EMAIL_SMTP_USER
//   YARU_COMPANY_NAME          seller's legal name on the receipt                  (needed for confirmations)
//   YARU_COMMUNITY_URL         optional: learner community invite link (shown once set)
//   YARU_MAIN_START            optional: overrides the main workshop start (MAIN_START below), ISO with +07:00
//   YARU_PRE_START             optional: overrides the VIP pre-game start (PRE_START below)
//   YARU_POST_START            optional: overrides the VIP post-game start (POST_START below)
//   YARU_MEET_URL              Google Meet link for the main workshop                (needed for main reminders)
//   YARU_VIP_MEET_URL          Google Meet link for the VIP pre-game and post-game   (needed for VIP reminders)
//   YARU_RECORDING_URL         setting this sends the recording email to every paid VIP + Essential buyer
//
// VIP buyers get two extra 2-hour sessions: a pre-game the day before and a post-game the day after.
"use strict";

const HOUR = 3600000;
// Main workshop confirmed by Will on 26 Oct 2026: Tue 17 Nov 2026, 7:30 PM Bangkok (12:30 UTC). YARU_MAIN_START overrides it.
// Buyers see times in UTC with a link to their own time zone; Bangkok time is never shown to buyers.
const MAIN_START = "2026-11-17T19:30:00+07:00";
// VIP pre-game and post-game, confirmed 26 Oct 2026: 2 hours each, the day before and the day after.
const PRE_START = "2026-11-16T19:30:00+07:00";
const POST_START = "2026-11-18T19:30:00+07:00";
const VIP_LENGTH = 2 * 3600000;
const validIso = (v) => (v && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);
const before = (iso, ms) => (iso ? new Date(Date.parse(iso) - ms).toISOString() : null);

// id, packages it applies to, when it is due, required config, and the latest useful time.
// Reminders: pre-game and main workshop 2 days + 2 hours before; post-game 2 hours before. VIP buyers attend all three.
const EMAILS = [
  { id: "confirm", packages: ["vip", "essential", "coaching"], due: (o) => o.paid_at, needs: ["company"] },
  { id: "pre_r1", packages: ["vip"], due: (o, c) => before(c.preStart, 48 * HOUR), until: (c) => c.preStart, reminder: true, needs: ["vipMeet"] },
  { id: "pre_final", packages: ["vip"], due: (o, c) => before(c.preStart, 2 * HOUR), until: (c) => c.preStart, reminder: true, needs: ["vipMeet"] },
  { id: "main_r1", packages: ["essential", "vip"], due: (o, c) => before(c.mainStart, 48 * HOUR), until: (c) => c.mainStart, reminder: true, needs: ["meet"] },
  { id: "main_final", packages: ["essential", "vip"], due: (o, c) => before(c.mainStart, 2 * HOUR), until: (c) => c.mainStart, reminder: true, needs: ["meet"] },
  { id: "post_final", packages: ["vip"], due: (o, c) => before(c.postStart, 2 * HOUR), until: (c) => c.postStart, reminder: true, needs: ["vipMeet"] },
  { id: "recording", packages: ["vip", "essential"], due: (o, c) => (c.recording ? c.recordingAt : null), needs: ["recording"] },
];

const SENDABLE_ENVS = ["production", "production-test", "store_link"];
const ACTIVE_STATUSES = ["paid", "partially_refunded"];
const MAX_ATTEMPTS = 8;

function configFromEnv(env = process.env) {
  return {
    enabled: env.EMAIL_ENABLED === "1",
    testOrdersOnly: env.EMAIL_TEST_ORDERS_ONLY === "1",
    smtpUser: env.EMAIL_SMTP_USER || "",
    smtpPass: env.EMAIL_SMTP_PASS || "",
    replyTo: env.EMAIL_REPLY_TO || env.EMAIL_SMTP_USER || "",
    company: env.YARU_COMPANY_NAME || "",
    community: env.YARU_COMMUNITY_URL || "",
    mainStart: validIso(env.YARU_MAIN_START || MAIN_START),
    preStart: validIso(env.YARU_PRE_START || PRE_START),
    postStart: validIso(env.YARU_POST_START || POST_START),
    meet: env.YARU_MEET_URL || "",
    vipMeet: env.YARU_VIP_MEET_URL || "",
    recording: env.YARU_RECORDING_URL || "",
    // The recording email is due from the first time the server sees the link set.
    recordingAt: env.YARU_RECORDING_URL ? new Date().toISOString() : null,
  };
}

const PACKAGE_NAMES = { essential: "Essential (live online on Google Meet)", vip: "VIP (live online + pre-game & post-game)", coaching: "1:1 coaching" };
const METHOD_NAMES = { card: "Credit/debit card (Stripe)" };
const isTest = (o) => String(o.beam_env || "").endsWith("-test");
const { money } = require("./currency");
const utc = (iso, opts) => new Date(iso).toLocaleString("en-GB", { timeZone: "UTC", ...opts });
const longDate = (iso) => utc(iso, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const shortDate = (iso) => utc(iso, { weekday: "short", day: "numeric", month: "short" });
const clock = (iso) => utc(iso, { hour: "2-digit", minute: "2-digit", hour12: false });
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const firstName = (o) => String(o.name || "").trim().split(/\s+/)[0] || "";

// ---------------------------------------------------------------------------
// Content. Each block is { h: heading?, lines: [...] } where a line is text or
// { text, url } (a link). Lines/blocks with a missing link are left out.
// ---------------------------------------------------------------------------
const SIGNATURE = ["Will Lin", "COO, Yaru", "admin@yaru.ai"];
// Link to the same moment in the reader's own time zone (timeanddate.com, p1=1440 = UTC).
const localLink = (iso) => ({ text: "See this time in your time zone",
  url: `https://www.timeanddate.com/worldclock/fixedtime.html?iso=${new Date(iso).toISOString().slice(0, 16).replace(/[-:]/g, "")}&p1=1440` });

function receiptBlock(o, c) {
  return { h: "Payment details", lines: [
    `Order number: ${o.ref}`,
    `Package: ${PACKAGE_NAMES[o.package] || o.package}`,
    `Amount paid: ${money(o.amount)}${isTest(o) ? " (test order)" : ""}`,
    `Payment date: ${o.paid_at ? longDate(o.paid_at) : "-"}`,
    o.payment_method ? `Payment method: ${METHOD_NAMES[o.payment_method] || o.payment_method}` : null,
    `Buyer: ${o.name} (${o.email})`,
    `Seller: ${c.company}`,
  ] };
}
const refundBlock = () => ({ h: "Cancellations and refunds", lines: [
  "You can get a full refund up to 3 days before your workshop date. After that we can't refund, but you can move to the next round once.",
  "Email admin@yaru.ai (or reply to this email) with your order number. Refunds are paid within 15 days of your request. This does not affect your statutory consumer rights.",
] });
const when = (start, time) => (start ? [`${longDate(start)} · ${time || clock(start)} UTC`, localLink(start)] : ["Date and time to be confirmed: we'll email you as soon as they're set."]);
const mainWhen = (c) => ({ h: "Main workshop (Google Meet)", lines: when(c.mainStart) });
const twoHours = (iso) => iso && `${clock(iso)}–${clock(new Date(Date.parse(iso) + VIP_LENGTH).toISOString())}`;
const preWhen = (c) => ({ h: "VIP pre-game (Google Meet, the day before)", lines: when(c.preStart, twoHours(c.preStart)) });
const postWhen = (c) => ({ h: "VIP post-game (Google Meet, the day after)", lines: when(c.postStart, twoHours(c.postStart)) });
const communityBlocks = (c) => [
  c.community && { h: "Join the learner community", lines: [{ text: "Join the community", url: c.community },
    "We share the materials and resources used in the workshop there."] },
].filter(Boolean);
const meetBlock = (o, url, h) => ({ h, lines: [{ text: "Google Meet link", url },
  `Please join with the email you registered: ${o.email}`, "The class is open only to registered email addresses."] });
const replyBlock = (o) => ({ h: "Important: reply to confirm the email you'll use for Google Meet", strong: true, lines: [
  "The online class is open only to registered email addresses. We'll send the invitation to:", o.email,
  "If that's right, reply \"Confirm\". To use a different Gmail address, reply with that address."] });
const prepBlock = { h: "What to prepare", lines: ["A computer that can run Google Meet",
  "If you can, a starter monthly plan of an AI tool (around 20 USD) so you can keep working without interruption"] };
const recordingBlock = { h: "Recording", lines: ["Please don't record during class. After the main workshop we'll send you the recording link."] };
const vipRecordingBlock = { h: "Recording", lines: ["Please don't record during class. After the main workshop we'll send you the recording link.",
  "The VIP pre-game and post-game are live only and are not recorded."] };

function compose(kind, o, c) {
  const hi = `Hi${firstName(o) ? " " + firstName(o) : ""},`;
  switch (kind) {
    case "confirm":
      if (o.package === "vip") return { subject: `You're in: Yaru workshop (VIP) · reply to confirm your Google Meet email · ${o.ref}`, intro: [hi,
        "Thank you for signing up for the Yaru workshop. We've received your payment."],
        blocks: [replyBlock(o), receiptBlock(o, c), preWhen(c), mainWhen(c), postWhen(c), vipRecordingBlock, ...communityBlocks(c), prepBlock, refundBlock()],
        outro: ["See you online."] };
      if (o.package === "essential") return { subject: `You're in: Yaru online workshop · reply to confirm your Google Meet email · ${o.ref}`, intro: [hi,
        "Thank you for signing up for the Yaru workshop. We've received your payment."],
        blocks: [replyBlock(o), receiptBlock(o, c), mainWhen(c), recordingBlock, ...communityBlocks(c), prepBlock, refundBlock()],
        outro: ["See you in class."] };
      return { subject: `You're in: 1:1 coaching with Yaru · ${o.ref}`, intro: [hi, "Thank you for signing up for coaching with Yaru. We've received your payment."],
        blocks: [receiptBlock(o, c), { h: "Next steps", lines: ["The Yaru team will contact you to schedule your first coaching session."] }, ...communityBlocks(c).slice(-1)], outro: [] };
    case "pre_r1":
      return { subject: `In 2 days: your Yaru VIP pre-game · ${shortDate(c.preStart)} ${clock(c.preStart)} UTC`, intro: [hi, "Your VIP pre-game is in 2 days. Here are your three sessions again."],
        blocks: [preWhen(c), meetBlock(o, c.vipMeet, "Join the pre-game"), mainWhen(c), postWhen(c)], outro: [] };
    case "pre_final":
      return { subject: `Starting soon: your Yaru VIP pre-game at ${clock(c.preStart)} UTC`, intro: [hi, "See you shortly in the VIP pre-game."],
        blocks: [preWhen(c), meetBlock(o, c.vipMeet, "Join the pre-game")], outro: ["See you soon."] };
    case "post_final":
      return { subject: `Starting soon: your Yaru VIP post-game at ${clock(c.postStart)} UTC`, intro: [hi, "See you shortly in the VIP post-game, where we go over your progress and next steps."],
        blocks: [postWhen(c), meetBlock(o, c.vipMeet, "Join the post-game")], outro: ["See you soon."] };
    case "main_r1":
      return { subject: `In 2 days: Yaru online workshop · ${shortDate(c.mainStart)} ${clock(c.mainStart)} UTC`, intro: [hi, "The Yaru online workshop is in 2 days."],
        blocks: [mainWhen(c), meetBlock(o, c.meet, "Join the workshop"), { h: "Haven't confirmed your email yet?", lines: ["Reply to this email with the Gmail address you'll use for Google Meet."] }], outro: [] };
    case "main_final":
      return { subject: `Starting soon: Yaru online workshop at ${clock(c.mainStart)} UTC`, intro: [hi, "See you shortly on Google Meet."],
        blocks: [mainWhen(c), meetBlock(o, c.meet, "Join the workshop")], outro: ["See you in class."] };
    case "recording":
      return { subject: "Your Yaru workshop recording is ready", intro: [hi,
        "Thank you for joining the Yaru workshop. The recording of the online workshop is ready to watch."],
        blocks: [{ h: "Watch the recording", lines: [{ text: "Open the recording", url: c.recording }, "Please don't share this link."] }, ...communityBlocks(c).slice(0, 1)], outro: [] };
  }
  throw new Error("unknown email " + kind);
}

function render(msg) {
  const line = (l) => (l && typeof l === "object" ? l : { text: l });
  const lines = (b) => b.lines.filter(Boolean).map(line).filter((l) => !("url" in l) || l.url);
  const blocks = msg.blocks.filter(Boolean);
  const text = [...msg.intro, "", ...blocks.flatMap((b) => [b.h ? `■ ${b.h}` : null,
    ...lines(b).map((l) => (l.url ? `${l.text}: ${l.url}` : l.text)), ""]).filter((x) => x !== null),
    ...msg.outro, "", ...SIGNATURE].join("\n");
  const html = `<!doctype html><html lang="en"><body style="margin:0;background:#f7f3ee;font-family:Sukhumvit Set,Tahoma,sans-serif;color:#1f1a14">
<div style="max-width:600px;margin:0 auto;padding:24px 16px"><div style="background:#fff;border-radius:12px;padding:28px">
<div style="color:#c62a35;font-weight:700;font-size:20px;margin-bottom:16px">Yaru</div>
${msg.intro.map((p) => `<p style="margin:0 0 10px;font-size:16px;line-height:1.6">${esc(p)}</p>`).join("")}
${blocks.map((b) => `<div style="margin-top:20px;${b.strong ? "background:#fdf1f2;border-left:4px solid #c62a35;padding:12px 14px;border-radius:6px" : ""}">
${b.h ? `<div style="font-weight:700;font-size:16px;margin-bottom:6px">${esc(b.h)}</div>` : ""}
${lines(b).map((l) => l.url ? `<p style="margin:4px 0"><a href="${esc(l.url)}" style="color:#c62a35;font-weight:700">${esc(l.text)}</a></p>`
    : `<p style="margin:4px 0;font-size:15px;line-height:1.6">${esc(l.text)}</p>`).join("")}</div>`).join("")}
${msg.outro.map((p) => `<p style="margin:20px 0 0;font-size:16px">${esc(p)}</p>`).join("")}
<p style="margin:24px 0 0;font-size:15px;line-height:1.5">${SIGNATURE.map(esc).join("<br>")}</p>
</div></div></body></html>`;
  return { subject: msg.subject, text, html };
}

function buildEmail(kind, order, config) {
  return render(compose(kind, order, config));
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------
function orderSendable(o, c) {
  return o && SENDABLE_ENVS.includes(o.beam_env) && ACTIVE_STATUSES.includes(o.status) && o.paid_at &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(o.email || "") && (!c.testOrdersOnly || isTest(o));
}
const missing = (spec, c) => (spec.needs || []).filter((k) => !c[k]);

function createEmailer({ store, config = configFromEnv(), transport, log = console } = {}) {
  let running = false;
  const status = () => ({
    enabled: config.enabled, testOrdersOnly: config.testOrdersOnly, smtp: Boolean(config.smtpUser && config.smtpPass && transport),
    missingForConfirmations: ["company"].filter((k) => !config[k]),
    meet: Boolean(config.meet), vipMeet: Boolean(config.vipMeet), mainStart: config.mainStart, preStart: config.preStart, postStart: config.postStart, recording: Boolean(config.recording),
  });

  async function run(nowMs = Date.now()) {
    if (!config.enabled || !transport || running) return;
    running = true;
    try {
      const nowIso = new Date(nowMs).toISOString();
      for (const listed of await store.list()) {
        if (!orderSendable(listed, config)) continue;
        for (const spec of EMAILS) {
          if (!spec.packages.includes(listed.package)) continue;
          const key = "email_" + spec.id;
          const st = listed.params?._delivery?.[key];
          if (st && st.status !== "pending") continue;
          try {
            const due = spec.due(listed, config);
            if (!due) continue;
            if (!st && spec.reminder && (Date.parse(listed.paid_at) > Date.parse(due) || nowMs > Date.parse(spec.until(config)))) {
              await store.setDelivery(listed.ref, key, { status: "skipped", reason: "bought after this reminder, or event already started" });
              continue;
            }
            if (nowMs < Date.parse(due)) continue;
            const gaps = missing(spec, config);
            if (gaps.length) continue; // waits until the link/setting exists (see /healthz)
            if (!st) {
              await store.setDelivery(listed.ref, key, { status: "pending", attempts: 0, queued_at: nowIso, next_at: nowIso });
            }
            if (!(await store.claimDelivery(listed.ref, key, new Date(nowMs + 5 * 60000).toISOString(), nowIso))) continue;
            const order = await store.byRef(listed.ref); // reload the saved record before sending
            const cur = { ...order.params._delivery[key], lease_until: null };
            if (!orderSendable(order, config)) {
              await store.setDelivery(order.ref, key, { ...cur, status: "cancelled", reason: `order is ${order.status}` });
              continue;
            }
            const mail = buildEmail(spec.id, order, config);
            cur.attempts = (cur.attempts || 0) + 1;
            cur.last_attempt_at = new Date().toISOString();
            try {
              const info = await transport.sendMail({ from: `"Will Lin | Yaru" <${config.smtpUser}>`, replyTo: config.replyTo,
                to: order.email, subject: mail.subject, text: mail.text, html: mail.html });
              Object.assign(cur, { status: "sent", sent_at: cur.last_attempt_at, message_id: info?.messageId || null, last_error: null });
              log.log(`[email] ${spec.id} sent for ${order.ref}`);
            } catch (err) {
              cur.last_error = String(err.message || err).slice(0, 300);
              if (cur.attempts >= MAX_ATTEMPTS) cur.status = "failed";
              else cur.next_at = new Date(Date.now() + Math.min(2 ** cur.attempts * 60000, 6 * 3600000)).toISOString();
              log.warn(`[email] ${spec.id} for ${order.ref} attempt ${cur.attempts} failed: ${cur.last_error}`);
            }
            await store.setDelivery(order.ref, key, cur);
          } catch (err) {
            log.warn(`[email] ${spec.id} for ${listed.ref}: ${err.message}; will retry`);
          }
        }
      }
    } finally {
      running = false;
    }
  }
  return { run, status };
}

function createSmtpTransport(config) {
  if (!config.smtpUser || !config.smtpPass) return null;
  const nodemailer = require("nodemailer");
  return nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: config.smtpUser, pass: config.smtpPass } });
}

module.exports = { EMAILS, configFromEnv, buildEmail, createEmailer, createSmtpTransport, orderSendable };
