// The English site charges in US dollars. Amounts everywhere (orders, Beam links, webhooks,
// refunds) are in the smallest unit, cents: 18000 = $180.
"use strict";

const CURRENCY = "USD";
const money = (minor) => "$" + (Number(minor || 0) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });

module.exports = { CURRENCY, money };
