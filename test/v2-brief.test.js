// V2 release rules from yaru-v2-rules-prompt.md (sections 1–5) checked against the shipped HTML.
// Approved strings are the ones start.yaru.ai's own copy tests pin (Replit test/workshop-copy.test.js
// and test/terms.test.js), so V2 can't drift from what Joshua signed off.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const read = (f) => fs.readFileSync(f, "utf8");
const pages = { index: read("public/index.html"), thanks: read("public/thank-you.html"), terms: read("public/terms.html"),
  termsOfUse: read("public/terms-of-use.html") };
const strip = (t) => t.replace(/[​⁠]/g, "");
// What a visitor can read: no scripts, styles or comments; tags removed; alt/title/meta kept.
function visible(html) {
  const attrs = [...html.matchAll(/\s(?:alt|title|aria-label|content)="([^"]*)"/g)].map((m) => m[1]).join(" ");
  const body = html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ");
  return strip(body + " " + attrs).replace(/\s+/g, " ");
}
// Text set from scripts that a visitor can see (thank-you states, checkout messages).
const scriptStrings = (html) => [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1]).join(" ").match(/"[^"\n]*[A-Za-z]+ [A-Za-z][^"\n]*"/g)?.join(" ") || "";
const customerText = Object.fromEntries(Object.entries(pages).map(([k, h]) => [k, visible(h) + " " + strip(scriptStrings(h))]));
const all = Object.values(customerText).join(" ");
const meta = (name) => pages.index.match(new RegExp(`<meta (?:name|property)="${name}" content="([^"]*)"`))?.[1];

// English translations of Joshua's approved Thai strings (start.yaru.ai). Pending his sign-off in English.
const HERO = "Build a business or side hustle with AI";
const DESCRIPTION = "A workshop designed to help you start building a side business, get a first draft made with AI, and plan how to test it directly with your target customers. Best of all, you don't need any coding background.";
const CONSENT = "Secure payment via Stripe · By purchasing, you agree to the Terms of Service and Privacy Policy , including the use of data for ad measurement (LINE, TikTok, Google)";
const COACHING_NOTE = "For those who want to work one-on-one with a coach";
const PHASES = ["Choose an idea", "Choose your tools and start building", "Plan how to test your idea", "Put the first version in front of real people", "Plan your next steps"];
// Thai allowed only for the seller's legal name.
const THAI_ALLOWED = /บริษัท ยารุ จำกัด/g;

test("§2 headline, title and all six metadata fields carry the approved copy", () => {
  assert(strip(visible(pages.index.replace(/<head>[\s\S]*<\/head>/, ""))).replace(/\s+/g, " ").includes(HERO), "hero headline");
  assert.equal(pages.index.match(/<title>([^<]*)<\/title>/)[1], `Yaru Create: ${HERO}`);
  for (const f of ["og:title", "twitter:title"]) assert.equal(meta(f), `Yaru Create: ${HERO}`, f);
  for (const f of ["description", "og:description", "twitter:description"]) assert.equal(meta(f), DESCRIPTION, f);
});

test("§1/§2 wording: 'workshop' not 'course'; package is 'Essential' not 'Basic'", () => {
  for (const [page, text] of Object.entries(customerText)) {
    assert(!/\bcourses?\b/i.test(text), `${page}: course`);
    assert(!/\bBasic\b/.test(text), `${page}: Basic package name`);
  }
});

test("§2 no prototype, earnings or overpromise wording anywhere a customer can read", () => {
  assert(!/\bprototypes?\b/i.test(all), "prototype");
  assert(!/make money|earn (?:money|income)|passive income|extra income|revenue|guaranteed (?:results|customers)|get rich(?! quick formula)/i.test(all), "earnings promise");
  assert(!/more than most (?:people|do)|no excuses|just show up|launch(?:ed)? (?:a|your) product|real users/i.test(all), "overpromise");
});

test("§2 one-day duration never appears in the headline, title or metadata", () => {
  const h1 = strip(pages.index.match(/<h1>([\s\S]*?)<\/h1>/)[1].replace(/<[^>]+>/g, ""));
  for (const t of [h1, pages.index.match(/<title>([^<]*)/)[1], ...["description", "og:description", "twitter:description"].map(meta)]) {
    assert(!/one day|1 day|single day|1-day/i.test(t || ""), t);
  }
});

test("§2 no five-day / challenge remnants", () => {
  assert(!/\b5 days?|\b5-day|five days?|challenge|\bday [1-5]\b/i.test(all));
});

test("§2 the five phases use the approved activity wording", () => {
  for (const p of PHASES) assert(customerText.index.includes(p), p);
});

test("§2 inclusions mention the 100+ curated AI business ideas", () => {
  assert(/100\+ curated AI business ideas/.test(customerText.index));
});

test("§3 no public placeholders", () => {
  for (const [page, html] of Object.entries(pages)) {
    assert(!/class="[^"]*\bph(?:-inline|-tag|-box)?\b/.test(html), `${page}: placeholder element`);
    assert(!/PLACEHOLDER|\bTBD\b|\bTBC\b|to be confirmed/i.test(customerText[page]), `${page}: placeholder text`);
  }
});

test("§3 FAQ answers only confirmed facts: no refund policy, no income question, community + credits covered, no tax invoices", () => {
  const faq = strip(pages.index.match(/<div class="faq">([\s\S]*?)<\/div>\s*<\/div>\s*<\/section>/)[1]);
  assert(!/refund/i.test(faq), "refund policy belongs on /terms, not the FAQ");
  assert(!/income|\bearn/i.test(faq), "income question");
  assert(/community/i.test(faq) && /during class/.test(faq), "community invite during class");
  assert(/credits may run out/.test(faq), "free tiers may run out of credits");
  assert(!/tax invoice/i.test(all), "tax-invoice section removed everywhere (Will, 26 Oct)");
});

test("§3 refund policy is stated on /terms with the statutory-rights disclaimer", () => {
  const t = visible(pages.terms);
  assert(/full refund up to 3 days before/i.test(t), "3-day full refund");
  assert(/move to the next round once/i.test(t), "move once");
  assert(/15 days/.test(t) && /statutory consumer rights/.test(t));
});

test("§1 coaching anchor uses the approved supporting line", () => {
  assert(customerText.index.includes(COACHING_NOTE));
});

test("§1 PDPA consent line under the pay button is the approved text with both links", () => {
  const legal = pages.index.match(/<p class="legal">([\s\S]*?)<\/p>/)[1];
  assert.equal(strip(legal.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(), CONSENT);
  assert.match(legal, /href="\/terms"/); assert.match(legal, /href="https:\/\/yaru\.ai\/privacy"/);
});

test("§4 CTA wording: primary 'See packages and sign up' → packages, secondary 'See what you'll work on' → activities", () => {
  assert.match(pages.index, /href="#pricing">See packages and sign up</);
  assert.match(pages.index, /href="#activities">See what you'll work on</);
  assert.match(pages.index, /id="activities"/);
});

test("§4 Sukhumvit Set is the only web font", () => {
  for (const [page, html] of Object.entries(pages)) {
    const families = [...html.matchAll(/@font-face\s*\{[^}]*font-family:\s*"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(families)], ["Sukhumvit"], page);
    assert(!/fonts\.googleapis|PPValve|Inter\b/.test(html), page);
  }
});

test("§5 one tag per platform per page, only the approved IDs, no GTM, no enhanced conversions", () => {
  for (const [page, html] of Object.entries(pages)) {
    assert.equal((html.match(/googletagmanager\.com\/gtag\/js/g) || []).length, 1, page);
    assert(!/GTM-|user_data|enhanced_conversions/.test(html), page);
    assert.deepEqual([...new Set(html.match(/AW-\d+/g))], ["AW-18496929738"], page);
    assert.deepEqual([...new Set(html.match(/ttq\.load\('([A-Z0-9]+)'\)/g))], ["ttq.load('DB3I03JC77U04C8M6HN0')"], page);
    assert.deepEqual([...new Set(html.match(/tagId: '([0-9a-f-]+)'/g))], ["tagId: '34e8f29d-a401-4dcc-b551-e49132bbd5d4'"], page);
  }
  const labels = [...new Set(pages.index.match(/AW-18496929738\/[A-Za-z0-9_]+/g))];
  assert.deepEqual(labels, ["AW-18496929738/2tSVCLv2mpUdEMr_gvRE"], "landing page fires only Begin checkout");
});

test("§5 funnel events respect window.yaruConsent.ads === false", () => {
  assert.match(pages.index, /function adsOff\(\) \{[^}]*window\.yaruConsent\.ads === false/, "consent helper");
  const submit = pages.index.slice(pages.index.indexOf('form.addEventListener("submit"'));
  const guard = submit.indexOf("var measure = !adsOff()"), lead = submit.indexOf('_lt("send", "cv"');
  assert(guard >= 0 && guard < lead, "consent check before the LINE lead");
  assert.match(submit, /if \(measure && window\.ttq\)/, "TikTok InitiateCheckout/identify gated");
  assert.match(submit, /if \(measure && typeof ck\.value === "number"/, "Begin checkout gated");
  assert(/function addToCart[\s\S]{0,200}if \(adsOff\(\)\) return;/.test(pages.index), "AddToCart gated");
  assert.match(pages.index, /if \(!\(window\.yaruConsent && window\.yaruConsent\.ads === false\)\) ttq\.track\('ViewContent'/, "ViewContent gated");
  assert.match(pages.thanks, /if \(window\.yaruConsent && window\.yaruConsent\.ads === false\) return;/, "purchase gated");
});

test("§5 Begin checkout fires only after the server accepted the order, with the server's value and currency", () => {
  const submit = pages.index.slice(pages.index.indexOf('form.addEventListener("submit"'));
  const fetchAt = submit.indexOf('fetch("/api/checkout"'), beginAt = submit.indexOf("2tSVCLv2mpUdEMr_gvRE");
  assert(fetchAt > 0 && beginAt > fetchAt, "after the checkout request");
  assert.match(submit.slice(fetchAt, beginAt), /if \(!r\.ok\) throw/);
  assert.match(submit.slice(fetchAt, beginAt + 200), /value: ck\.value, currency: ck\.currency/);
  assert.match(submit, /if \(busy\) return;/, "one attempt at a time");
  assert.match(submit, /ev\.persisted/, "reset on Back (bfcache)");
});

test("footer links both terms pages and the privacy policy; no Replit-injected analytics in V2 pages", () => {
  for (const href of ["/terms", "/terms-of-use", "https://yaru.ai/privacy"]) {
    assert(pages.index.match(/<footer>[\s\S]*<\/footer>/)[0].includes(`href="${href}"`), href);
  }
  for (const [page, html] of Object.entries(pages)) assert(!/i\.replit\.com\/script\.js/.test(html), page);
  assert.match(visible(pages.termsOfUse), /Yaru Co\., Ltd\./);
});

test("testimonials section is hidden while empty and visible once it has real cards", () => {
  const section = pages.index.match(/<section id="testimonials"[^>]*>[\s\S]*?<\/section>/)[0];
  const cards = (section.match(/class="tcard"/g) || []).length;
  const hidden = /<section id="testimonials"[^>]*\shidden[\s>]/.test(section);
  if (cards === 0) assert(hidden, "an empty testimonials section must stay hidden");
  else { assert(!hidden, "remove `hidden` once real testimonials are in"); assert(cards >= 1); }
});

test("English site: pages are English, don't advertise the teaching language, and carry no Thai-round or in-person details", () => {
  for (const [page, html] of Object.entries(pages)) {
    assert.match(html, /<html lang="en">/, page);
    const thai = customerText[page].replace(THAI_ALLOWED, "").match(/[ก-ฺเ-๛]+/g);
    assert.equal(thai, null, `${page}: Thai text ${thai}`);
    assert(!/Rama 4|ONE BANGKOK|17th floor|17F|WorkLab|drinks|snacks|\b6 Nov|\b11 Nov|seats? left|\d+ seats/i.test(customerText[page]), `${page}: Thai-round/in-person detail`);
  }
  assert(!/taught in english/i.test(all), "teaching language isn't presented (Will, 26 Oct)");
  assert(!/Bangkok time|GMT\+7|\+07:00 \(|ICT\b/.test(all), "no Bangkok time shown to buyers (Will, 26 Oct)");
  assert(/shown in your time zone/.test(customerText.index), "page says times are local");
  for (const m of pages.index.matchAll(/<time class="lt" datetime="([^"]+)" data-f="([a-z]+)"(?: data-end="([^"]+)")?>([^<]*)<\/time>/g)) {
    assert(Number.isFinite(Date.parse(m[1])), m[1]);
    assert(/UTC|^\w{3} \d{1,2} \w{3}$/.test(m[4]), `no-JS fallback is UTC or date-only: ${m[4]}`);
    if (m[2].includes("range")) assert(Number.isFinite(Date.parse(m[3])), "range has an end");
  }
  assert(!/<s>|<s class/.test(pages.index), "no crossed-out prices until confirmed real for the English rounds");
});

test("server: English site domain, English item names, no default seat cap or cut-off", () => {
  const server = read("server.js");
  assert.match(server, /const SITE_URL = "https:\/\/challenge\.yaru\.ai";/);
  assert(!/item: "[^"]*[ก-ฺเ-๛]/.test(server), "Beam item names in English");
  assert.match(server, /essential: \{[^}]*amount: 18000 \}/); assert.match(server, /vip: \{[^}]*amount: 30000 \}/); assert.match(server, /coaching: \{[^}]*amount: 999900 \}/);
  assert.match(server, /const STRIPE = \{/); assert(!/beamcheckout|BEAM_API_KEY/.test(server), "no Beam calls left");
  assert.match(read("lib/currency.js"), /const CURRENCY = "USD";/);
});

test("main workshop date is the confirmed one everywhere: Tue 17 Nov 2026, 7:30 PM Bangkok", () => {
  assert(/Tuesday 17 November 2026/.test(customerText.index) && /Tuesday 17 November 2026/.test(customerText.terms));
  assert(!/24 Nov|17 or 24/.test(all), "no leftover alternative date");
  const { configFromEnv } = require("../lib/emails");
  assert.equal(configFromEnv({}).mainStart, new Date("2026-11-17T19:30:00+07:00").toISOString(), "emails use the same start");
});

test("VIP pre-game (Mon 16 Nov) and post-game (Wed 18 Nov), 12:30–14:30 UTC, match on page, terms and emails", () => {
  for (const t of [customerText.index, customerText.terms]) {
    assert(/pre-game/.test(t) && /post-game/.test(t));
    assert(/16 Nov/.test(t) && /18 Nov/.test(t) && /12:30–14:30 UTC/.test(t));
  }
  const { configFromEnv } = require("../lib/emails");
  const c = configFromEnv({});
  assert.equal(c.preStart, new Date("2026-11-16T19:30:00+07:00").toISOString());
  assert.equal(c.postStart, new Date("2026-11-18T19:30:00+07:00").toISOString());
});

test("VIP pre-game and post-game are stated as live only, not recorded, on page, terms and VIP emails", () => {
  assert(/pre-game and post-game are live only/.test(customerText.index));
  assert(/pre-game and post-game are live only and are not recorded/.test(customerText.terms));
  const { buildEmail, configFromEnv } = require("../lib/emails");
  const o = { ref: "5W-AAAAAAAAA1", name: "A", email: "a@example.com", package: "vip", amount: 999000, beam_env: "production", paid_at: "2026-10-12T05:00:00Z" };
  assert(/not recorded/.test(buildEmail("confirm", o, { ...configFromEnv({}), company: "Yaru Co., Ltd." }).text));
});

test("prices are USD everywhere a buyer looks: $180 / $300 / $9,999, no baht", () => {
  for (const p of ["$180", "$300", "$9,999"]) assert(customerText.index.includes(p), p);
  assert(/USD 9,999/.test(customerText.terms));
  for (const [page, text] of Object.entries(customerText)) assert(!/฿|\bTHB\b|baht|PromptPay|\bBeam\b/i.test(text), page);
  assert.match(pages.index, /var PRICES = \{ essential: 180, vip: 300, coaching: 9999 \};/);
  assert(!/currency: "THB"|currency: 'THB'/.test(pages.index + pages.thanks), "ad events use USD");
  assert.match(pages.thanks, /if \(o\.currency !== "USD"\) return;/);
});

test("page times: every session uses the confirmed instants and is rendered in the visitor's zone", () => {
  const times = [...pages.index.matchAll(/<time class="lt" datetime="([^"]+)"[^>]*?(?: data-end="([^"]+)")?>/g)];
  const starts = new Set(times.map((m) => new Date(m[1]).toISOString()));
  assert.deepEqual([...starts].sort(), ["2026-11-16T12:30:00.000Z", "2026-11-17T12:30:00.000Z", "2026-11-18T12:30:00.000Z"]);
  for (const m of times) if (m[2]) assert.equal(Date.parse(m[2]) - Date.parse(m[1]), 2 * 3600000, "VIP sessions are 2 hours");
  assert.match(pages.index, /document\.querySelectorAll\("time\.lt"\)/, "local-time formatter present");
});

test("contact: no LINE contact anywhere; contact form posts to /api/contact; form only, all fields required", () => {
  for (const [page, html] of Object.entries(pages)) assert(!/lin\.ee|LINE Official|@Yaru\b|line_add_friends/.test(html), page);
  assert.match(pages.index, /id="contact-form"/); assert.match(pages.index, /fetch\("\/api\/contact"/);
  const section = pages.index.match(/<section[^>]*id="contact"[\s\S]*?<\/section>/)[0];
  assert(!/mailto:|admin@yaru\.ai/.test(section), "contact section offers the form only (Will, 26 Oct)");
  assert.equal((section.match(/\srequired[\s>]/g) || []).length, 3, "name, email and message all required");
});

test("countdown: counts to the real main-workshop start and is backed by an enforced cut-off; no red banner", () => {
  assert(!/class="announce"/.test(pages.index), "top banner removed (Will, 26 Oct)");
  assert.match(pages.index, /id="countdown" hidden/);
  assert.match(pages.index, /var MAIN_START = "2026-11-17T19:30:00\+07:00";/);
  assert(/Sign-ups close 30 minutes before the workshop starts/.test(customerText.index));
  const server = read("server.js");
  assert.match(server, /const SALES_CLOSE = \{ vip: "2026-11-16T19:30:00\+07:00", essential: "2026-11-17T19:30:00\+07:00" \};/);
  assert.match(server, /if \(salesClosed\(pkgKey\)\) return res\.status\(409\)/, "checkout enforces it");
});

