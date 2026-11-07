"use strict";

// Logger dùng chung cho các service Node của Finhay và FHSC.
// Mỗi lời gọi log ra đúng một dòng JSON theo Log JSON schema v1 (src/log-schema-v1.json),
// không ném lỗi vào code gọi, không sửa object được truyền vào, và lấy
// request-id / trace của OpenTelemetry ngay lúc gọi.
// Giữ cú pháp ES2018 để còn chạy được trên Node 12.

const winston = require("winston");
const rTracer = require("cls-rtracer");
const safeStringify = require("safe-stable-stringify").configure({
  deterministic: false,
  bigint: true,
  circularValue: "[Circular]",
});
const schema = require("./schema");
const redact = require("./redact");
const { activeSpanContext } = require("./trace");

const LEVEL = Symbol.for("level");
const MESSAGE = Symbol.for("message");
const ERROR = Symbol("finhay-logger.error");
const FIELDS = Symbol("finhay-logger.fields");
const TRACE = Symbol("finhay-logger.trace");

// Docker (log driver json-file / fluentd của FireLens) cắt dòng dài hơn 16 KB
// thành nhiều bản ghi, làm hỏng JSON. Giữ cả dòng dưới ngưỡng đó.
const DEFAULT_MAX_MESSAGE_BYTES = 8 * 1024;
const DEFAULT_MAX_STACK_BYTES = 4 * 1024;
// Giới hạn cho cả dòng JSON (Docker cắt ở 16384 byte), chừa chỗ cho xuống dòng
const DEFAULT_MAX_LINE_BYTES = 16000;
const MAX_REQUEST_ID_BYTES = 256;

const TOKEN = /%[sdifjoOc%]/g;

// Key mà winston hoặc logger tự đặt trên info, không phải meta của người gọi
const INFO_KEYS = new Set(["timestamp", "level", "message", "request_id", "trace_id", "span_id", "trace_flags"]);

function isError(value) {
  return (
    value instanceof Error ||
    (value !== null &&
      typeof value === "object" &&
      typeof value.message === "string" &&
      typeof value.stack === "string")
  );
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function stringify(value, replacer) {
  try {
    const json = safeStringify(value, replacer);
    return json === undefined ? String(value) : json;
  } catch (e) {
    return `[Unserializable: ${e && e.message}]`;
  }
}

// Che rồi cắt chuỗi về maxBytes. Chuỗi rất dài được cắt thô trước để regex che không
// phải chạy trên hàng MB; che trước khi cắt để không để lại nửa token chưa bị che.
function finalize(text, maxBytes, scrub) {
  if (typeof text !== "string") return text;
  const limit = typeof maxBytes === "number" && maxBytes >= 0 ? maxBytes : Infinity;
  const capped = text.length > limit * 4 ? text.slice(0, limit * 4) : text;
  const clean = scrub ? scrub(capped) : capped;
  if (capped === text && Buffer.byteLength(clean) <= limit) return clean;
  const head = Buffer.from(clean).subarray(0, limit).toString().replace(/\uFFFD$/, "");
  const dropped = Math.max(Buffer.byteLength(text) - Buffer.byteLength(head), 0);
  return `${head}…[truncated ${dropped} bytes]`;
}

// DomainException... không đặt name nên name vẫn là "Error"; dùng tên lớp để phân loại
function errorType(err) {
  const ctor = err.constructor && err.constructor.name;
  if ((!err.name || err.name === "Error") && ctor && ctor !== "Error" && ctor !== "Object") return ctor;
  return err.name || "Error";
}

function errorStack(err) {
  let stack = typeof err.stack === "string" ? err.stack : `${errorType(err)}: ${err.message}`;
  let cause = err.cause;
  for (let depth = 0; isError(cause) && depth < 3; depth++) {
    stack += `\nCaused by: ${cause.stack || cause.message}`;
    cause = cause.cause;
  }
  return stack;
}

function errorLabel(err) {
  return `${errorType(err)}: ${err.message}`;
}

function toText(value, serialize) {
  if (typeof value === "string") return value;
  if (isError(value)) return errorLabel(value);
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "object") return serialize(value);
  return String(value);
}

function formatToken(token, value, serialize) {
  switch (token) {
    case "%d":
    case "%i":
    case "%f":
      if (typeof value === "bigint") return String(value);
      if (typeof value === "object" && value !== null) return "NaN";
      if (token === "%i") return String(parseInt(value, 10));
      if (token === "%f") return String(parseFloat(value));
      return String(Number(value));
    case "%c":
      return "";
    default:
      // %s, %j, %o, %O: object -> JSON một dòng, Error -> "Tên: message"
      return toText(value, serialize);
  }
}

// Biến đối số của một lời gọi log thành message, Error chính và field schema.
// - Placeholder kiểu util.format được thay.
// - Đối số thừa là chuỗi/số... được nối vào message (giống console.log).
// - Error đầu tiên ra error_*; Error thêm được nối "Tên: message".
// - Object thường: key thuộc schema (event_name, durationMs, ...) thành field,
//   key còn lại nối vào message dạng JSON để không sinh field tuỳ ý trên ES.
function parseArgs(args, serialize) {
  const result = { message: "", error: undefined, fields: {} };
  if (args.length === 0) return result;

  const parts = [];
  const first = args[0];
  let rest;

  if (typeof first === "string") {
    let index = 1;
    parts.push(
      first.replace(TOKEN, (token) => {
        if (token === "%%") return "%";
        if (index >= args.length) return token;
        const value = args[index++];
        if (!result.error && isError(value)) result.error = value;
        return formatToken(token, value, serialize);
      })
    );
    rest = args.slice(index);
  } else if (isError(first)) {
    result.error = first;
    parts.push(first.message || errorType(first));
    rest = args.slice(1);
  } else {
    parts.push(toText(first, serialize));
    rest = args.slice(1);
  }

  for (const value of rest) {
    if (isError(value)) {
      if (!result.error) result.error = value;
      else parts.push(errorLabel(value));
    } else if (isPlainObject(value)) {
      const leftover = splitFields(value, result);
      if (leftover) parts.push(serialize(leftover));
    } else {
      parts.push(toText(value, serialize));
    }
  }

  result.message = parts.join(" ");
  return result;
}

// Tách key thuộc schema ra result.fields; trả phần còn lại (hoặc undefined nếu rỗng)
function splitFields(object, result) {
  const keys = Object.keys(object);
  let leftover;
  for (const key of keys) {
    const value = object[key];
    if (key === "error" && isError(value) && !result.error) {
      result.error = value;
      continue;
    }
    const name = schema.registeredName(key);
    if (name) {
      result.fields[name] = value;
    } else {
      if (!leftover) leftover = {};
      leftover[key] = value;
    }
  }
  // Không tách key nào thì giữ object gốc (tham chiếu vòng vẫn được nhận ra đúng chỗ)
  return leftover && Object.keys(leftover).length === keys.length ? object : leftover;
}

function resolveFormat(opts, env) {
  const explicit = opts.format || env.LOG_FORMAT;
  if (explicit) return String(explicit).toLowerCase();
  const nodeEnv = schema.resolveEnvironment(env.NODE_ENV);
  return nodeEnv === "local" || nodeEnv === "test" ? "text" : "json";
}

function createLogger(options) {
  const opts = options || {};
  const env = process.env;
  const format = resolveFormat(opts, env);
  const service = opts.service || env.OTEL_SERVICE_NAME || env.SERVICE_NAME || env.npm_package_name || "unknown";
  const environment = schema.resolveEnvironment(opts.environment || env.NODE_ENV);
  const maxMessageBytes = Number(opts.maxMessageBytes || env.LOG_MAX_MESSAGE_BYTES) || DEFAULT_MAX_MESSAGE_BYTES;
  const maxStackBytes = Number(opts.maxStackBytes || env.LOG_MAX_STACK_BYTES) || DEFAULT_MAX_STACK_BYTES;
  const maxLineBytes = Number(opts.maxLineBytes || env.LOG_MAX_LINE_BYTES) || DEFAULT_MAX_LINE_BYTES;

  // Che credential luôn bật (tắt được bằng option redact: false, chỉ nên dùng cho test);
  // che SĐT/email chỉ khi bật maskPii / LOG_MASK_PII=true.
  const redactEnabled = opts.redact !== false;
  const piiEnabled = opts.maskPii !== undefined ? Boolean(opts.maskPii) : /^(1|true|yes)$/i.test(env.LOG_MASK_PII || "");
  const extraKeys = (opts.redactKeys || []).concat((env.LOG_REDACT_KEYS || "").split(",").map((k) => k.trim()));
  const isSensitiveKey = redactEnabled ? redact.createKeyMatcher(extraKeys) : () => false;
  const replacer = redactEnabled || piiEnabled ? redact.createReplacer(isSensitiveKey, piiEnabled) : undefined;
  const serialize = (value) => stringify(value, replacer);
  // Che theo chuỗi dùng cùng luật key với che theo object (gồm key thêm qua LOG_REDACT_KEYS)
  const scrubSecrets = redactEnabled ? redact.createTextRedactor(isSensitiveKey) : undefined;
  const scrub =
    redactEnabled || piiEnabled
      ? (text) => {
          let out = scrubSecrets ? scrubSecrets(text) : text;
          if (piiEnabled) out = redact.maskPii(out);
          return out;
        }
      : undefined;
  // Field văn bản tự do được che cả PII; field định danh (user_id, error_code...) chỉ che
  // credential vì PII sẽ che nhầm id dạng số.
  const FREE_TEXT_FIELDS = new Set(["message", "error_message", "error_stack"]);
  const UNTOUCHED_FIELDS = new Set(["schema_version", "timestamp", "level", "service", "environment", "request_id", "trace_id", "span_id"]);
  // Field có pattern trong schema: bản bị cắt không còn hợp lệ nên chuyển sang <tên>_invalid
  const PATTERN_FIELDS = new Set(["event_name", "http_method", "http_route"]);

  // Cắt một field về limit byte; field có pattern bị cắt thì đổi tên thành <tên>_invalid.
  // Trả về tên field sau khi cắt.
  function trimField(record, key, limit, scrubFn) {
    const value = finalize(record[key], limit, scrubFn);
    if (value === record[key] || !PATTERN_FIELDS.has(key)) {
      record[key] = value;
      return key;
    }
    delete record[key];
    record[key + schema.INVALID_SUFFIX] = value;
    return key + schema.INVALID_SUFFIX;
  }

  // Dựng bản ghi schema v1 từ info (đã qua logger.child nếu có)
  function toRecord(info) {
    const record = {
      schema_version: schema.SCHEMA_VERSION,
      timestamp: info.timestamp,
      level: schema.toLevel(info.level),
      service,
    };
    if (environment) record.environment = environment;
    record.message = typeof info.message === "string" ? info.message : toText(info.message, serialize);
    if (info.request_id) record.request_id = info.request_id;

    // Trace lấy lúc gọi; nếu không có thì dùng giá trị instrumentation-winston gắn vào info
    const captured = info[TRACE] || {};
    const trace = captured.traceId
      ? captured
      : schema.traceContext(info.trace_id, info.span_id);
    if (trace.traceId) record.trace_id = trace.traceId;
    if (trace.spanId) record.span_id = trace.spanId;

    // Meta của logger.child(): field schema giữ lại, phần còn lại nối vào message
    let leftover;
    for (const key of Object.keys(info)) {
      if (INFO_KEYS.has(key)) continue;
      const name = schema.registeredName(key);
      if (name) {
        schema.setRegistered(record, name, info[key], serialize);
      } else if (!schema.CORE_FIELDS.has(key)) {
        if (!leftover) leftover = {};
        leftover[key] = info[key];
      }
    }
    if (leftover) record.message += ` ${serialize(leftover)}`;

    // Field của lời gọi thắng meta của child
    const fields = info[FIELDS] || {};
    for (const name of Object.keys(fields)) {
      schema.setRegistered(record, name, fields[name], serialize);
    }

    // Field suy ra từ Error không đè field người gọi đã đặt
    const err = info[ERROR];
    if (err) {
      const response = err.response && typeof err.response === "object" ? err.response : {};
      const code = err.errorCode !== undefined ? err.errorCode : err.code;
      const derived = {
        error_type: errorType(err),
        error_message: err.message,
        error_stack: errorStack(err),
        error_code: typeof code === "string" || typeof code === "number" ? code : undefined,
        http_status_code: typeof err.statusCode === "number" ? err.statusCode : response.status,
      };
      for (const name of Object.keys(derived)) {
        if (!(name in record)) {
          const probe = {};
          schema.setRegistered(probe, name, derived[name], serialize);
          if (probe[name] !== undefined) record[name] = probe[name];
        }
      }
    }

    // Mọi field chuỗi (message, error_*, field schema do người gọi đặt, <tên>_invalid)
    // đều được che rồi cắt độ dài trước khi ghi
    for (const key of Object.keys(record)) {
      if (UNTOUCHED_FIELDS.has(key) || typeof record[key] !== "string") continue;
      const freeText = FREE_TEXT_FIELDS.has(key) || key.slice(-schema.INVALID_SUFFIX.length) === schema.INVALID_SUFFIX;
      const limit = key === "error_stack" ? maxStackBytes : maxMessageBytes;
      trimField(record, key, limit, freeText ? scrub : scrubSecrets);
    }
    return record;
  }

  const render =
    format === "text"
      ? winston.format((info) => {
          const record = toRecord(info);
          const rid = record.request_id ? ` [request-id:${record.request_id}]` : "";
          const extra = {};
          for (const key of Object.keys(record)) {
            if (!schema.CORE_FIELDS.has(key) && key !== "error_stack") extra[key] = record[key];
          }
          const meta = Object.keys(extra).length > 0 ? ` ${serialize(extra)}` : "";
          const stack = record.error_stack ? `\n${record.error_stack}` : "";
          info[MESSAGE] = `${record.timestamp} ${info.level}${rid}: ${record.message}${meta}${stack}`;
          return info;
        })
      : winston.format((info) => {
          info[MESSAGE] = fitLine(toRecord(info));
          return info;
        });

  // Giới hạn từng field chưa đủ: message, error_message, error_stack có thể cùng chứa một
  // nội dung dài, cộng thêm ký tự escape của JSON. Nếu cả dòng vượt maxLineBytes thì cắt
  // tiếp field chuỗi lớn nhất cho tới khi vừa.
  function fitLine(record) {
    let line = stringify(record);
    let size = Buffer.byteLength(line);
    // Mỗi vòng cắt field lớn nhất; dừng khi vừa hoặc không còn field nào cắt được
    while (size > maxLineBytes) {
      let largest;
      let largestSize = 0;
      for (const key of Object.keys(record)) {
        if (UNTOUCHED_FIELDS.has(key) || typeof record[key] !== "string") continue;
        const fieldSize = Buffer.byteLength(JSON.stringify(record[key]));
        if (fieldSize > largestSize) {
          largest = key;
          largestSize = fieldSize;
        }
      }
      if (!largest || largestSize <= 64) break;
      // Tỉ lệ byte thô / byte sau escape để cắt đủ ngay cả khi chuỗi nhiều ký tự escape
      const raw = Buffer.byteLength(record[largest]);
      const target = Math.max(Math.floor((raw * (largestSize - (size - maxLineBytes) - 64)) / largestSize), 0);
      trimField(record, largest, target);
      line = stringify(record);
      const next = Buffer.byteLength(line);
      if (next >= size) break;
      size = next;
    }
    if (size <= maxLineBytes) return line;
    // Vẫn vượt (vd quá nhiều field ngắn): chỉ giữ field lõi và message đã cắt
    const minimal = {};
    for (const key of Object.keys(record)) {
      if (UNTOUCHED_FIELDS.has(key)) minimal[key] = record[key];
    }
    minimal.message = finalize(String(record.message || ""), Math.max(maxLineBytes - Buffer.byteLength(stringify(minimal)) - 128, 0));
    minimal.log_truncated = true;
    return stringify(minimal);
  }

  const logger = winston.createLogger({
    level: opts.level || env.LOG_LEVEL || "info",
    format: render(),
    transports:
      opts.transports ||
      (opts.stream
        ? [new winston.transports.Stream({ stream: opts.stream })]
        : [new winston.transports.Console()]),
  });

  function entryFor(level, args) {
    const info = { timestamp: new Date().toISOString(), level, message: "" };
    try {
      const rid = rTracer.id();
      // request_id có thể lấy từ header X-Request-Id (dữ liệu ngoài): giới hạn độ dài
      if (rid !== undefined && rid !== null) info.request_id = finalize(String(rid), MAX_REQUEST_ID_BYTES);
      const span = activeSpanContext();
      if (span) info[TRACE] = schema.traceContext(span.traceId, span.spanId);
      const parsed = parseArgs(args, serialize);
      info.message = parsed.message;
      if (parsed.error) info[ERROR] = parsed.error;
      info[FIELDS] = parsed.fields;
    } catch (e) {
      info.message = `[finhay-logger] failed to format log: ${e && e.message}`;
    }
    info[LEVEL] = level;
    return info;
  }

  function emit(self, level, args) {
    if (!self.isLevelEnabled(level)) return self;
    self.write(entryFor(level, args));
    return self;
  }

  Object.keys(logger.levels).forEach((level) => {
    logger[level] = function (...args) {
      return emit(this, level, args);
    };
  });

  // log(level, ...args) | log({ level, message, ...meta }) | log(message)
  logger.log = function (first, ...rest) {
    if (first !== null && typeof first === "object" && !isError(first) && typeof first.level === "string") {
      const { level, message, ...meta } = first;
      const args = message === undefined ? [""] : [message];
      if (Object.keys(meta).length > 0) args.push(meta);
      return emit(this, this.levels[level] !== undefined ? level : "info", args);
    }
    if (typeof first === "string" && this.levels[first] !== undefined) {
      return emit(this, first, rest);
    }
    return emit(this, "info", [first, ...rest]);
  };

  // Dùng cho morgan: bỏ xuống dòng ở cuối để không sinh dòng trống.
  logger.stream = {
    write(message) {
      logger.info(String(message).replace(/\r?\n$/, ""));
    },
  };

  logger.service = service;
  logger.environment = environment;
  return logger;
}

const logger = createLogger();

if (resolveFormat({}, process.env) === "json" && !logger.environment) {
  logger.warn(
    `NODE_ENV="${process.env.NODE_ENV}" is not one of production|staging|development|local|test; field environment is omitted`
  );
}

module.exports = {
  logger,
  createLogger,
  SCHEMA_VERSION: schema.SCHEMA_VERSION,
  maskPhoneOrEmail: redact.maskPhoneOrEmail,
  maskPii: redact.maskPii,
  maskUrl: redact.maskUrl,
  redactSecretsInText: redact.redactSecretsInText,
};
