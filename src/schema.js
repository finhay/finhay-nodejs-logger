"use strict";

// Log JSON schema v1.0.0 (dùng chung với FHSC, xem log-schema-v1.json).
// Mọi quy tắc đặt tên field, kiểu dữ liệu và map level nằm ở file này.

const SCHEMA_VERSION = "1.0.0";

// Field lõi chỉ do logger quyết định; meta của người gọi không đè được.
const CORE_FIELDS = new Set([
  "schema_version",
  "timestamp",
  "level",
  "service",
  "environment",
  "message",
  "request_id",
  "trace_id",
  "span_id",
  "trace_flags",
]);

// winston level -> level của schema
const LEVELS = {
  silly: "trace",
  verbose: "debug",
  debug: "debug",
  http: "info",
  info: "info",
  warn: "warn",
  error: "error",
};

const ENVIRONMENTS = {
  production: "prod",
  prod: "prod",
  staging: "staging",
  development: "develop",
  develop: "develop",
  local: "local",
  test: "test",
};

const STRING_FIELDS = [
  "logger",
  "service_version",
  "error_code",
  "error_type",
  "error_message",
  "error_stack",
  "target_service",
  "messaging_system",
  "messaging_destination",
  "message_id",
  "job_name",
  "job_run_id",
  "user_id",
  "account_id",
  "sub_account_id",
  "order_id",
  "transaction_id",
  "business_request_id",
];

const OTHER_FIELDS = ["event_name", "duration_ms", "outcome", "http_method", "http_route", "http_status_code"];

// Tên field đã đăng ký trong schema (ngoài field lõi)
const REGISTERED_FIELDS = new Set(STRING_FIELDS.concat(OTHER_FIELDS));

// Khoá camelCase (LogField của FHSC) -> tên field đầu ra
const ALIASES = {
  requestId: "business_request_id",
  eventName: "event_name",
  durationMs: "duration_ms",
  httpMethod: "http_method",
  httpRoute: "http_route",
  httpStatusCode: "http_status_code",
  targetService: "target_service",
  messagingSystem: "messaging_system",
  messagingDestination: "messaging_destination",
  messageId: "message_id",
  jobName: "job_name",
  jobRunId: "job_run_id",
  errorCode: "error_code",
  serviceVersion: "service_version",
  userId: "user_id",
  accountId: "account_id",
  subAccountId: "sub_account_id",
  orderId: "order_id",
  transactionId: "transaction_id",
};

const OUTCOMES = new Set(["success", "failure", "timeout", "cancelled", "unknown"]);
const TRACE_ID = /^(?!0{32}$)[0-9a-f]{32}$/;
const SPAN_ID = /^(?!0{16}$)[0-9a-f]{16}$/;
const INVALID_SUFFIX = "_invalid";

function toLevel(level) {
  return LEVELS[level] || "info";
}

function resolveEnvironment(value) {
  if (typeof value !== "string") return undefined;
  return ENVIRONMENTS[value.trim().toLowerCase()];
}

// Tên field đầu ra cho một khoá meta, hoặc undefined nếu không thuộc schema
function registeredName(key) {
  if (REGISTERED_FIELDS.has(key)) return key;
  return Object.prototype.hasOwnProperty.call(ALIASES, key) ? ALIASES[key] : undefined;
}

function toNumber(value) {
  if (typeof value === "number") return value;
  return typeof value === "string" && value.trim() !== "" ? Number(value) : undefined;
}

// Giá trị đúng kiểu schema, hoặc undefined nếu sai kiểu
function coerce(name, value, stringify) {
  switch (name) {
    case "http_status_code": {
      const code = toNumber(value);
      return Number.isInteger(code) && code >= 100 && code <= 599 ? code : undefined;
    }
    case "duration_ms": {
      const duration = toNumber(value);
      return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
    }
    case "outcome":
      return OUTCOMES.has(value) ? value : undefined;
    case "http_method": {
      const method = typeof value === "string" ? value.toUpperCase() : "";
      return /^[A-Z]+$/.test(method) ? method : undefined;
    }
    case "event_name":
      return typeof value === "string" && /^[a-z][a-z0-9_]*$/.test(value) ? value : undefined;
    case "http_route":
      return typeof value === "string" && value.charAt(0) === "/" ? value : undefined;
    default: {
      if (value === undefined || value === null) return undefined;
      const text = typeof value === "object" ? stringify(value) : String(value);
      return text === "" ? undefined : text;
    }
  }
}

// Ghi field đã đăng ký vào record; sai kiểu thì giữ dạng chuỗi ở <tên>_invalid
function setRegistered(record, name, value, stringify) {
  if (value === undefined || value === null || value === "") return;
  const coerced = coerce(name, value, stringify);
  // Giá trị sau (vd của lời gọi) thay hẳn giá trị trước (vd của child): xoá bản kia
  if (coerced !== undefined) {
    record[name] = coerced;
    delete record[name + INVALID_SUFFIX];
  } else {
    record[name + INVALID_SUFFIX] = typeof value === "object" ? stringify(value) : String(value);
    delete record[name];
  }
}

function traceContext(traceId, spanId) {
  if (typeof traceId !== "string" || !TRACE_ID.test(traceId)) return {};
  return typeof spanId === "string" && SPAN_ID.test(spanId) ? { traceId, spanId } : { traceId };
}

module.exports = {
  SCHEMA_VERSION,
  CORE_FIELDS,
  INVALID_SUFFIX,
  toLevel,
  resolveEnvironment,
  registeredName,
  setRegistered,
  traceContext,
};
