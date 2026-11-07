"use strict";

// Lấy span đang active của OpenTelemetry tại thời điểm gọi log.
// @opentelemetry/api là optional: OTel operator inject SDK ở thư mục riêng nên
// app có thể không cài gói này; khi đó đọc thẳng registry global của API v1.

let api = null;
try {
  // eslint-disable-next-line global-require
  api = require("@opentelemetry/api");
} catch (e) {
  api = null;
}

const GLOBAL_KEY = Symbol.for("opentelemetry.js.api.1");
const SPAN_KEY = Symbol.for("OpenTelemetry Context Key SPAN");

function fromApi() {
  if (!api) return undefined;
  const span = api.trace.getActiveSpan();
  return span ? span.spanContext() : undefined;
}

function fromGlobal() {
  const registry = global[GLOBAL_KEY];
  const manager = registry && registry.context;
  if (!manager || typeof manager.active !== "function") return undefined;
  const context = manager.active();
  const span = context && typeof context.getValue === "function" ? context.getValue(SPAN_KEY) : undefined;
  return span && typeof span.spanContext === "function" ? span.spanContext() : undefined;
}

function activeSpanContext() {
  try {
    return fromApi() || fromGlobal();
  } catch (e) {
    return undefined;
  }
}

module.exports = { activeSpanContext };
