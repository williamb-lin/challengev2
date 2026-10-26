// Beam Refunds API and webhook objects use the smallest currency unit (USD: cents).
// Field names still say "satang" (shared with the Thai site); on this site they hold cents.
const { CURRENCY } = require("./currency");
// https://docs.beamcheckout.com/refunds/refunds-api
// https://docs.beamcheckout.com/webhook-event-types
function refundSatang(refund) {
  const amount = refund.amount_satang ?? refund.amount;
  return refund.refund_id && refund.charge_id && refund.currency === CURRENCY &&
    Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function refundSummary(order) {
  const seen = new Map();
  const review = [];
  if (!Number.isSafeInteger(Number(order.amount)) || Number(order.amount) <= 0) review.push("Order amount is unverified");
  for (const refund of order.params?._refunds || []) {
    const amount = refundSatang(refund);
    if (amount === null) { review.push("Invalid or unverified refund amount/currency/identity"); continue; }
    if (order.params?._beam?.charge_id && order.params._beam.charge_id !== refund.charge_id) {
      review.push("Refund charge does not match order"); continue;
    }
    const previous = seen.get(refund.refund_id);
    if (previous && (previous.amount !== amount || previous.charge !== refund.charge_id)) {
      review.push("Conflicting duplicate refund"); continue;
    }
    seen.set(refund.refund_id, { amount, charge: refund.charge_id });
  }
  const total = [...seen.values()].reduce((sum, refund) => sum + refund.amount, 0);
  if (!Number.isSafeInteger(total) || total > Number(order.amount)) review.push("Refund total exceeds order amount");
  return { total, review, status: review.length || !total ? null :
    total === Number(order.amount) ? "refunded" : "partially_refunded" };
}

function applyRefund(order, event, now = new Date().toISOString()) {
  const params = { ...(order.params || {}) };
  const refunds = [...(params._refunds || [])];
  const priorReview = params._refund_review;
  const reviews = { ...(priorReview?.entries || (priorReview ?
    { [priorReview.refund_id || "missing-refund-id"]: priorReview } : {})) };
  const reviewKey = event.refundId || "missing-refund-id";
  let problem = null;
  if (event.status !== "SUCCEEDED" || event.referenceId !== order.ref ||
      event.currency !== CURRENCY || !event.refundId || !event.chargeId ||
      !Number.isSafeInteger(event.amount) || event.amount <= 0) {
    problem = "Refund payload has unverified status, identity, currency or amount";
  } else if (params._beam?.charge_id && params._beam.charge_id !== event.chargeId) {
    problem = "Refund charge does not match this order";
  }
  const existing = refunds.find(refund => refund.refund_id === event.refundId);
  if (!problem && existing && (refundSatang(existing) !== event.amount || existing.charge_id !== event.chargeId)) {
    problem = "Conflicting notification for an existing refund ID";
  }
  if (!problem && !existing) {
    const timestamp = [event.transactionTime, event.updatedAt, now].find(value => value && Number.isFinite(Date.parse(value)));
    refunds.push({ refund_id: event.refundId, charge_id: event.chargeId, amount: event.amount,
      amount_satang: event.amount, currency: CURRENCY, at: timestamp });
  }
  const summary = refundSummary({ ...order, params: { ...params, _refunds: refunds } });
  if (!problem && summary.review.length) problem = summary.review.join("; ");
  if (problem) {
    reviews[reviewKey] = { refund_id: event.refundId || null, reason: problem, at: now };
    params._refund_review = { ...Object.values(reviews)[0], entries: reviews };
    return { params }; // retain the last verified refunds and status; never guess
  }
  params._refunds = refunds;
  delete reviews[reviewKey];
  if (Object.keys(reviews).length) params._refund_review = { ...Object.values(reviews)[0], entries: reviews };
  else delete params._refund_review;
  return { params, ...(summary.status ? { status: summary.status } : {}) };
}

const isTestOrder = order => String(order.beam_env || "").endsWith("-test") || order.beam_env === "playground" || order.beam_env === "demo";
const isProductionOrder = order => order.beam_env === "production";
const refundAmountBaht = (_order, refund) => {
  const amount = refundSatang(refund);
  return amount === null ? null : amount / 100;
};
module.exports = { refundSatang, refundSummary, applyRefund, refundAmountBaht, isTestOrder, isProductionOrder };
