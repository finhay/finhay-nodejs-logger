"use strict";

// Che dữ liệu nhạy cảm trong log.
// - Credential (mật khẩu, OTP, token, secret, API key, cookie...): luôn che.
//   + Theo tên key khi serialize object.
//   + Theo mẫu trong chuỗi cuối (Bearer, JWT, query string, JSON lồng trong chuỗi).
// - PII (SĐT, email): chỉ che khi bật maskPii, vì vận hành đang tra log theo SĐT/email.
// Các regex ở đây đều chạy tuyến tính theo độ dài chuỗi.

const REDACTED = "[REDACTED]";

// Từ cuối của tên key (sau khi tách camelCase/snake_case/kebab-case)
const SENSITIVE_LAST_WORDS = new Set([
  "password",
  "passwd",
  "pwd",
  "passcode",
  "pin",
  "otp",
  "secret",
  "token",
  "cookie",
  "authorization",
  "cvv",
  "cvc",
  "jwt",
]);

// Hai từ cuối ghép lại
const SENSITIVE_LAST_PAIRS = new Set([
  "apikey",
  "privatekey",
  "secretkey",
  "accesskey",
  "biometrickey",
  "pincode",
  "otpcode",
  "cardnumber",
  "codeverifier",
  "sessionid",
]);

const PHONE_KEY = /phone|mobile/i;

function keyWords(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function createKeyMatcher(extraKeys) {
  const extra = new Set(
    (extraKeys || []).map((key) => keyWords(key).join("")).filter(Boolean)
  );
  return function isSensitiveKey(key) {
    if (typeof key !== "string" || key === "") return false;
    const words = keyWords(key);
    if (words.length === 0) return false;
    const last = words[words.length - 1];
    if (SENSITIVE_LAST_WORDS.has(last)) return true;
    if (words.indexOf("password") !== -1 || words.indexOf("passwd") !== -1) return true;
    if (words.length > 1 && SENSITIVE_LAST_PAIRS.has(words[words.length - 2] + last)) return true;
    return extra.size > 0 && (extra.has(words.join("")) || extra.has(last));
  };
}

// Mẫu "key=value", "key": value... nhận mọi tên key rồi quyết định bằng isSensitiveKey,
// để che theo chuỗi và che theo object dùng chung một luật (kể cả key thêm qua
// LOG_REDACT_KEYS). Tên key giới hạn 64 ký tự để regex vẫn tuyến tính.
const KEY = "[A-Za-z_][A-Za-z0-9_.-]{0,63}";

function createTextRedactor(isSensitiveKey) {
  const patterns = [
    // Authorization: Bearer <token> / Basic <base64>
    [/\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/gi, (m, scheme) => `${scheme} ${REDACTED}`],
    // JWT (header.payload.signature)
    [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, () => REDACTED],
    // Dòng kiểu header: "Cookie: a=1; b=2" -> che tới hết dòng
    [
      new RegExp(`(^|[\\r\\n])([ \\t]*)(${KEY})[ \\t]*:[ \\t]*([^\\r\\n]+)`, "g"),
      (m, pre, indent, key) => (isSensitiveKey(key) ? `${pre}${indent}${key}: ${REDACTED}` : m),
    ],
    // JSON trong chuỗi: "key": "..." | số
    [
      new RegExp(`"(${KEY})"(\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|-?\\d+(?:\\.\\d+)?)`, "g"),
      (m, key, sep) => (isSensitiveKey(key) ? `"${key}"${sep}"${REDACTED}"` : m),
    ],
    // JSON đã escape một lần: \"key\":\"...\"
    [
      new RegExp(`\\\\"(${KEY})\\\\"(\\s*:\\s*)(\\\\"(?:[^\\\\]|\\\\[^"])*\\\\"|-?\\d+)`, "g"),
      (m, key, sep) => (isSensitiveKey(key) ? `\\"${key}\\"${sep}\\"${REDACTED}\\"` : m),
    ],
    // Kiểu util.inspect / YAML trong câu: key: 'value' | key: value
    [
      new RegExp(`(^|[\\s{,(\\[])(${KEY})(\\s*:\\s*)('(?:[^'\\\\]|\\\\.)*'|[^\\s,'"}\\][]+)`, "g"),
      (m, pre, key, sep, value) =>
        isSensitiveKey(key) ? `${pre}${key}${sep}${value.charAt(0) === "'" ? `'${REDACTED}'` : REDACTED}` : m,
    ],
    // Query string / form: key=value (giá trị tới &, khoảng trắng, # hoặc dấu nháy)
    [
      new RegExp(`(^|[?&;\\s,{(\\[])(${KEY})=([^&\\s#"']+)`, "g"),
      (m, pre, key) => (isSensitiveKey(key) ? `${pre}${key}=${REDACTED}` : m),
    ],
  ];
  return function redactText(text) {
    if (typeof text !== "string" || text === "") return text;
    let out = text;
    for (const [pattern, replace] of patterns) {
      pattern.lastIndex = 0;
      out = out.replace(pattern, replace);
    }
    return out;
  };
}

const redactSecretsInText = createTextRedactor(createKeyMatcher());

// ---- PII (chép từ vnsc-auth Util.ts, bản đã hotfix quét email tuyến tính) ----

// Email -> ký tự đầu + *** + @domain; SĐT 9-15 chữ số -> 3 số đầu + **** + 3 số cuối; còn lại giữ nguyên
function maskPhoneOrEmail(value) {
  if (typeof value !== "string" || !value) return value;
  const atIndex = value.indexOf("@");
  if (atIndex > 0) return `${value.charAt(0)}***${value.slice(atIndex)}`;
  const digits = value.replace(/[\s+().-]/g, "");
  if (/^\d{9,15}$/.test(digits)) return `${digits.slice(0, 3)}****${digits.slice(-3)}`;
  return value;
}

// Ký tự không thuộc địa chỉ email: '@', khoảng trắng của \s và dấu phân cách hay gặp
// trong JSON, query string, URL (vnsc-auth chỉ dừng ở khoảng trắng nên che lấn sang
// cả đoạn '{"email":"' đứng trước)
const ADDRESS_STOP = new Set('"\'`:=,;<>()[]{}/?&\\|'.split("").map((c) => c.charCodeAt(0)));

function isAddressChar(code) {
  if (code === 64 || code === 32 || (code >= 9 && code <= 13) || ADDRESS_STOP.has(code)) return false;
  if (code < 160) return true;
  return !(
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  );
}

// Tương đương /[^\s@]+@[^\s@]+\.[^\s@]+/g nhưng một lượt tuyến tính
function maskEmailsInText(text) {
  if (text.indexOf("@") === -1) return text;
  let out = "";
  let copiedUntil = 0;
  let at = text.indexOf("@");
  while (at !== -1) {
    let start = at;
    while (start > copiedUntil && isAddressChar(text.charCodeAt(start - 1))) start--;
    let end = at + 1;
    while (end < text.length && isAddressChar(text.charCodeAt(end))) end++;
    const domain = text.slice(at + 1, end);
    const firstDot = domain.indexOf(".", 1);
    if (start < at && firstDot !== -1 && firstDot < domain.length - 1) {
      out += text.slice(copiedUntil, start) + maskPhoneOrEmail(text.slice(start, end));
      copiedUntil = end;
    }
    at = text.indexOf("@", end);
  }
  return out + text.slice(copiedUntil);
}

function maskPhoneCandidate(candidate) {
  const digits = candidate.replace(/\D/g, "");
  if (digits.length > 15) return `${digits.slice(0, 3)}****${digits.slice(-3)}`;
  return maskPhoneOrEmail(candidate);
}

// Che mọi email và SĐT (0912.345.678, 0912 345 678, (+84)912345678...) trong một chuỗi
function maskPii(text) {
  if (typeof text !== "string" || !text) return text;
  return maskEmailsInText(text).replace(/\+?\(?\d[\d\s().+-]{7,}\d/g, maskPhoneCandidate);
}

// Che URL để log: credential trong query bị thay, SĐT/email trong path và query bị che
function maskUrl(url) {
  if (typeof url !== "string" || !url) return url;
  const scrubbed = redactSecretsInText(url);
  const cut = scrubbed.search(/[?#]/);
  const path = cut === -1 ? scrubbed : scrubbed.slice(0, cut);
  const rest = cut === -1 ? "" : scrubbed.slice(cut);
  const maskedPath = path
    .split("/")
    .map((segment) => {
      if (!segment) return segment;
      try {
        const decoded = decodeURIComponent(segment);
        const masked = maskPhoneOrEmail(decoded);
        return masked === decoded ? segment : masked;
      } catch (e) {
        return segment;
      }
    })
    .join("/");
  const maskedRest = rest.replace(/([?&][^=&#]*=)([^&#]*)/g, (match, key, value) => {
    try {
      const decoded = decodeURIComponent(value);
      const masked = maskPhoneOrEmail(decoded);
      return masked === decoded ? match : key + masked;
    } catch (e) {
      return match;
    }
  });
  return maskedPath + maskedRest;
}

// Replacer cho safe-stable-stringify: che giá trị ở key nhạy cảm (giữ boolean/null như otpFound: true)
function createReplacer(isSensitiveKey, piiEnabled) {
  return function replacer(key, value) {
    if (key === "") return value;
    if (value === null || value === undefined || typeof value === "boolean") return value;
    if (isSensitiveKey(key)) return REDACTED;
    if (piiEnabled) {
      if (typeof value === "string") return maskPii(value);
      if (typeof value === "number" && PHONE_KEY.test(key)) return maskPhoneOrEmail(String(value));
    }
    return value;
  };
}

module.exports = {
  REDACTED,
  createKeyMatcher,
  createReplacer,
  createTextRedactor,
  redactSecretsInText,
  maskPhoneOrEmail,
  maskPii,
  maskUrl,
};
