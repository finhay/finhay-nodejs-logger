"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const Ajv = require("ajv");
const otel = require("@opentelemetry/api");
const { AsyncLocalStorage } = require("node:async_hooks");
const rTracer = require("cls-rtracer");
const Transport = require("winston-transport");
const { createLogger } = require("../src");
const logSchema = require("../src/log-schema-v1.json");

// ContextManager tối giản (thay cho @opentelemetry/context-async-hooks, gói này đòi Node mới)
const storage = new AsyncLocalStorage();
otel.context.setGlobalContextManager({
  active: () => storage.getStore() || otel.ROOT_CONTEXT,
  with: (context, fn, thisArg, ...args) => storage.run(context, () => fn.apply(thisArg, args)),
  bind: (context, target) => target,
  enable() {
    return this;
  },
  disable() {
    return this;
  },
});

const validate = new Ajv({ allErrors: true }).compile(logSchema);
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

function setup(options) {
  const stream = new PassThrough();
  const lines = [];
  stream.on("data", (chunk) => lines.push(...chunk.toString().split("\n").filter(Boolean)));
  const logger = createLogger({ stream, service: "svc", environment: "test", format: "json", ...options });
  return {
    logger,
    lines,
    async entries() {
      await flush();
      return lines.map((line) => JSON.parse(line));
    },
  };
}

// Mọi bản ghi JSON đều phải hợp lệ theo log-schema-v1.json
async function one(log, options) {
  const ctx = setup(options);
  log(ctx.logger);
  const entries = await ctx.entries();
  assert.equal(entries.length, 1, `expected one entry, got ${ctx.lines.join(" | ")}`);
  assert.ok(validate(entries[0]), JSON.stringify(validate.errors));
  return entries[0];
}

test("core fields follow schema v1", async () => {
  const entry = await one((l) => l.info("hello"));
  assert.deepEqual(Object.keys(entry), ["schema_version", "timestamp", "level", "service", "environment", "message"]);
  assert.equal(entry.schema_version, "1.0.0");
  assert.equal(entry.service, "svc");
  assert.equal(entry.environment, "test");
  assert.match(entry.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("maps winston levels to schema levels", async () => {
  const levels = {};
  for (const level of ["error", "warn", "info", "http", "verbose", "debug", "silly"]) {
    levels[level] = (await one((l) => l[level]("x"), { level: "silly" })).level;
  }
  assert.deepEqual(levels, {
    error: "error",
    warn: "warn",
    info: "info",
    http: "info",
    verbose: "debug",
    debug: "debug",
    silly: "trace",
  });
});

test("environment comes from NODE_ENV values and is omitted when unknown", async () => {
  assert.equal((await one((l) => l.info("x"), { environment: "production" })).environment, "prod");
  assert.equal((await one((l) => l.info("x"), { environment: "Development " })).environment, "develop");
  const ctx = setup({ environment: "qa" });
  ctx.logger.info("x");
  const [entry] = await ctx.entries();
  assert.equal("environment" in entry, false);
});

test("service falls back to OTEL_SERVICE_NAME", async () => {
  const saved = process.env.OTEL_SERVICE_NAME;
  process.env.OTEL_SERVICE_NAME = "products-demo";
  try {
    assert.equal((await one((l) => l.info("x"), { service: undefined })).service, "products-demo");
  } finally {
    if (saved === undefined) delete process.env.OTEL_SERVICE_NAME;
    else process.env.OTEL_SERVICE_NAME = saved;
  }
});

test("keeps extra string arguments (issue #1)", async () => {
  assert.equal((await one((l) => l.error("X:", "msg"))).message, "X: msg");
});

test("error passed as extra argument goes to error_* fields", async () => {
  const entry = await one((l) => l.error("X:", new Error("boom")));
  assert.equal(entry.message, "X:");
  assert.equal(entry.error_type, "Error");
  assert.equal(entry.error_message, "boom");
  assert.match(entry.error_stack, /^Error: boom\n\s+at /);
});

test("error passed alone becomes message and error_* fields", async () => {
  const entry = await one((l) => l.error(new Error("boom")));
  assert.equal(entry.message, "boom");
  assert.equal(entry.error_message, "boom");
});

test("error consumed by a placeholder keeps error_* fields", async () => {
  const entry = await one((l) => l.error("failed: %o", new TypeError("bad")));
  assert.equal(entry.message, "failed: TypeError: bad");
  assert.equal(entry.error_type, "TypeError");
});

test("error under the error key of meta is used", async () => {
  const entry = await one((l) => l.error("job failed", { error: new Error("boom"), jobName: "sync" }));
  assert.equal(entry.message, "job failed");
  assert.equal(entry.error_message, "boom");
  assert.equal(entry.job_name, "sync");
});

test("second error is appended to message", async () => {
  const entry = await one((l) => l.error("two:", new Error("a"), new RangeError("b")));
  assert.equal(entry.message, "two: RangeError: b");
  assert.equal(entry.error_message, "a");
});

test("error type uses class name, code and http status", async () => {
  class DomainException extends Error {}
  const err = new DomainException("not found");
  err.errorCode = "USER_NOT_FOUND";
  err.statusCode = 404;
  const entry = await one((l) => l.warn(err));
  assert.equal(entry.error_type, "DomainException");
  assert.equal(entry.error_code, "USER_NOT_FOUND");
  assert.equal(entry.http_status_code, 404);
});

test("axios error: status from response, no config or headers leaked", async () => {
  const err = new Error("Request failed with status code 502");
  err.code = "ERR_BAD_RESPONSE";
  err.config = { url: "https://x/pay?token=secret", headers: { Authorization: "Bearer t" } };
  err.response = { status: 502, data: { secret: "s" } };
  const entry = await one((l) => l.error("call failed:", err));
  assert.equal(entry.http_status_code, 502);
  assert.equal(entry.error_code, "ERR_BAD_RESPONSE");
  assert.doesNotMatch(JSON.stringify(entry), /secret|Bearer/);
});

test("field set by caller wins over field derived from error", async () => {
  const err = new Error("x");
  err.statusCode = 500;
  const entry = await one((l) => l.error("upstream", err, { httpStatusCode: 502 }));
  assert.equal(entry.http_status_code, 502);
});

test("error cause chain is in error_stack", async () => {
  const entry = await one((l) => l.error(new Error("outer", { cause: new Error("inner") })));
  assert.match(entry.error_stack, /Caused by: Error: inner/);
});

test("schema fields in meta become fields, camelCase or snake_case", async () => {
  const entry = await one((l) =>
    l.info("request done", {
      eventName: "http_request_completed",
      http_method: "get",
      httpRoute: "/v1/users/:id",
      httpStatusCode: "200",
      durationMs: 12.5,
      outcome: "success",
      userId: 42,
      requestId: "biz-1",
    })
  );
  assert.equal(entry.message, "request done");
  assert.equal(entry.event_name, "http_request_completed");
  assert.equal(entry.http_method, "GET");
  assert.equal(entry.http_route, "/v1/users/:id");
  assert.equal(entry.http_status_code, 200);
  assert.equal(entry.duration_ms, 12.5);
  assert.equal(entry.outcome, "success");
  assert.equal(entry.user_id, "42");
  assert.equal(entry.business_request_id, "biz-1");
  assert.equal("request_id" in entry, false);
});

test("wrongly typed schema field is kept as <name>_invalid", async () => {
  const entry = await one((l) => l.info("x", { httpStatusCode: "abc", outcome: "maybe", durationMs: -1 }));
  assert.equal(entry.http_status_code_invalid, "abc");
  assert.equal(entry.outcome_invalid, "maybe");
  assert.equal(entry.duration_ms_invalid, "-1");
});

test("other meta keys are appended to message, core fields cannot be overridden", async () => {
  const entry = await one((l) => l.info("x", { message: "m", a: 1, service: "evil", level: "fatal" }));
  assert.equal(entry.message, 'x {"message":"m","a":1,"service":"evil","level":"fatal"}');
  assert.equal(entry.service, "svc");
  assert.equal(entry.level, "info");
  assert.equal("a" in entry, false);
});

test("formats placeholders", async () => {
  assert.equal((await one((l) => l.info("a %s", "b"))).message, "a b");
  assert.equal((await one((l) => l.info("%d%% of %s", 50, "x"))).message, "50% of x");
  assert.equal((await one((l) => l.info("obj %o", { a: 1 }))).message, 'obj {"a":1}');
  assert.equal((await one((l) => l.info("%o", [1, 2]))).message, "[1,2]");
  assert.equal((await one((l) => l.info("missing %s"))).message, "missing %s");
});

test("logs a single object as JSON message", async () => {
  assert.equal((await one((l) => l.info({ a: 1, b: 2 }))).message, '{"a":1,"b":2}');
});

test("does not throw on circular objects", async () => {
  const circular = { a: 1 };
  circular.self = circular;
  assert.equal((await one((l) => l.info("c", circular))).message, 'c {"a":1,"self":"[Circular]"}');
});

test("does not mutate objects passed in", async () => {
  const err = new Error("boom");
  const obj = { message: "m", userId: 1 };
  await one((l) => l.error(err));
  await one((l) => l.info("x", obj));
  await one((l) => l.log({ level: "info", message: "x", a: 1 }));
  assert.deepEqual(Object.keys(err), []);
  assert.deepEqual(Object.getOwnPropertySymbols(err), []);
  assert.deepEqual(obj, { message: "m", userId: 1 });
  assert.deepEqual(Object.getOwnPropertySymbols(obj), []);
});

test("writes exactly one line per call, even with multi-line content", async () => {
  const ctx = setup();
  ctx.logger.error("line1\nline2", new Error("boom"));
  await flush();
  assert.equal(ctx.lines.length, 1);
  assert.equal(JSON.parse(ctx.lines[0]).message, "line1\nline2");
});

test("supports log() call shapes used by services", async () => {
  const a = await one((l) => l.log("warn", "%s done", "job"));
  assert.deepEqual([a.level, a.message], ["warn", "job done"]);
  const b = await one((l) => l.log("plain message"));
  assert.deepEqual([b.level, b.message], ["info", "plain message"]);
  const c = await one((l) => l.log({ level: "error", message: "m", code: 7, eventName: "job_completed" }));
  assert.deepEqual([c.level, c.message, c.event_name], ["error", 'm {"code":7}', "job_completed"]);
});

test("default level is info", async () => {
  const ctx = setup({ level: undefined });
  ctx.logger.debug("hidden");
  ctx.logger.info("shown");
  assert.deepEqual((await ctx.entries()).map((e) => e.message), ["shown"]);
});

test("stream for morgan drops the trailing newline", async () => {
  assert.equal((await one((l) => l.stream.write("GET / 200 1ms\n"))).message, "GET / 200 1ms");
});

test("request_id from cls-rtracer, omitted outside a request", async () => {
  const ctx = setup();
  rTracer.runWithId(() => ctx.logger.info("in request"), "rid-1");
  ctx.logger.info("outside");
  const [inside, outside] = await ctx.entries();
  assert.equal(inside.request_id, "rid-1");
  assert.equal("request_id" in outside, false);
});

test("captures request_id at call time even when the transport is slow", async () => {
  const seen = [];
  const slow = new (class extends Transport {
    log(info, callback) {
      seen.push(JSON.parse(info[Symbol.for("message")]));
      setTimeout(callback, 1);
    }
  })();
  const logger = createLogger({ transports: [slow], service: "svc", environment: "test", format: "json" });
  for (let i = 0; i < 100; i++) {
    rTracer.runWithId(() => logger.info(`req ${i}`), `id${i}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(seen.length, 100);
  assert.equal(seen.filter((e) => e.request_id !== `id${e.message.split(" ")[1]}`).length, 0);
});

test("trace_id and span_id from the active OpenTelemetry span", async () => {
  const spanContext = {
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    traceFlags: otel.TraceFlags.SAMPLED,
  };
  const ctx = setup();
  otel.context.with(otel.trace.setSpanContext(otel.context.active(), spanContext), () => ctx.logger.info("in span"));
  ctx.logger.info("no span");
  const [inSpan, noSpan] = await ctx.entries();
  assert.equal(inSpan.trace_id, spanContext.traceId);
  assert.equal(inSpan.span_id, spanContext.spanId);
  assert.equal("trace_flags" in inSpan, false);
  assert.equal("trace_id" in noSpan, false);
  assert.ok(validate(inSpan), JSON.stringify(validate.errors));
});

test("uses trace fields added by instrumentation-winston, drops invalid ones", async () => {
  // instrumentation-winston gắn trace_id/span_id/trace_flags vào info; child() mô phỏng việc đó
  const valid = await one((l) =>
    l.child({ trace_id: "4bf92f3577b34da6a3ce929d0e0e4736", span_id: "00f067aa0ba902b7", trace_flags: "01" }).info("x")
  );
  assert.equal(valid.trace_id, "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.equal(valid.span_id, "00f067aa0ba902b7");
  assert.equal("trace_flags" in valid, false);
  const invalid = await one((l) => l.child({ trace_id: "0".repeat(32), span_id: "abc" }).info("x"));
  assert.equal("trace_id" in invalid, false);
  assert.equal("span_id" in invalid, false);
});

test("truncates oversized message and stack", async () => {
  const ctx = setup({ maxMessageBytes: 100, maxStackBytes: 50 });
  ctx.logger.error("x".repeat(500), new Error("boom"));
  const [entry] = await ctx.entries();
  assert.match(entry.message, /^x{100}…\[truncated 400 bytes\]$/);
  assert.match(entry.error_stack, /…\[truncated \d+ bytes\]$/);
});

test("child logger: schema keys become fields, other keys go to message", async () => {
  const entry = await one((l) => l.child({ logger: "jobs", module: "sync" }).warn("tick %d", 1));
  assert.deepEqual([entry.level, entry.logger, entry.message], ["warn", "jobs", 'tick 1 {"module":"sync"}']);
});

test("text format keeps the legacy prefix", async () => {
  const ctx = setup({ format: "text" });
  rTracer.runWithId(() => ctx.logger.error("X:", "msg", { durationMs: 5 }), "rid-2");
  await flush();
  assert.match(ctx.lines[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z error \[request-id:rid-2\]: X: msg \{"duration_ms":5\}$/);
});

// ---- Che dữ liệu nhạy cảm ----

test("redacts credential keys in objects, keeps booleans and unrelated keys", async () => {
  const entry = await one((l) =>
    l.info("login", {
      user: "a",
      password: "p",
      newPassword: "n",
      password_confirm: "c",
      otp: 123456,
      otpFound: true,
      otpType: "SMS",
      accessToken: "t",
      tokenType: "Bearer",
      apiKey: "k",
      headers: { authorization: "Bearer abc", cookie: "sid=1", "x-api-key": "k2" },
      transactionPin: "1234",
    })
  );
  const meta = JSON.parse(entry.message.slice("login ".length));
  assert.deepEqual(meta, {
    user: "a",
    password: "[REDACTED]",
    newPassword: "[REDACTED]",
    password_confirm: "[REDACTED]",
    otp: "[REDACTED]",
    otpFound: true,
    otpType: "SMS",
    accessToken: "[REDACTED]",
    tokenType: "Bearer",
    apiKey: "[REDACTED]",
    headers: { authorization: "[REDACTED]", cookie: "[REDACTED]", "x-api-key": "[REDACTED]" },
    transactionPin: "[REDACTED]",
  });
});

test("redacts keys in %o/%j arguments, single objects and child meta", async () => {
  assert.equal((await one((l) => l.info("body %o", { pin: "1" }))).message, 'body {"pin":"[REDACTED]"}');
  assert.equal((await one((l) => l.info({ secret: "s", a: 1 }))).message, '{"secret":"[REDACTED]","a":1}');
  const child = await one((l) => l.child({ clientSecret: "s", module: "m" }).info("x"));
  assert.equal(child.message, 'x {"clientSecret":"[REDACTED]","module":"m"}');
});

test("redacts secrets inside strings: query, JSON, Bearer, JWT", async () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl";
  const entry = await one((l) =>
    l.info(
      "GET /auth/password?password=abc&uid=5 body:%s auth=Bearer abc.def token %s",
      JSON.stringify({ email: "a@b.co", newPassword: "x", otp: 999999 }),
      jwt
    )
  );
  assert.equal(
    entry.message,
    'GET /auth/password?password=[REDACTED]&uid=5 body:{"email":"a@b.co","newPassword":"[REDACTED]","otp":"[REDACTED]"} auth=Bearer [REDACTED] token [REDACTED]'
  );
});

test("redacts secrets in error_message, error_stack and <name>_invalid", async () => {
  const err = new Error("call failed with token=abc123");
  const entry = await one((l) => l.error("x", err, { httpStatusCode: "Bearer zzz" }));
  assert.equal(entry.error_message, "call failed with token=[REDACTED]");
  assert.match(entry.error_stack, /^Error: call failed with token=\[REDACTED\]/);
  assert.equal(entry.http_status_code_invalid, "Bearer [REDACTED]");
});

test("redaction happens before truncation, so a cut never leaves part of a secret", async () => {
  const ctx = setup({ maxMessageBytes: 40 });
  ctx.logger.info(`${"x".repeat(30)} password=supersecretvalue`);
  const [entry] = await ctx.entries();
  assert.doesNotMatch(entry.message, /supersec/);
});

test("extra keys from LOG_REDACT_KEYS / redactKeys", async () => {
  const entry = await one((l) => l.info("kyc", { cccd: "0123", idNumber: "9", name: "A" }), { redactKeys: ["cccd", "id_number"] });
  assert.equal(entry.message, 'kyc {"cccd":"[REDACTED]","idNumber":"[REDACTED]","name":"A"}');
});

test("PII is kept by default", async () => {
  const entry = await one((l) => l.info("send to 0912345678", { email: "nam@gmail.com" }));
  assert.equal(entry.message, 'send to 0912345678 {"email":"nam@gmail.com"}');
});

test("maskPii masks phone and email in message, meta and errors", async () => {
  const entry = await one(
    (l) =>
      l.error("send to 0912.345.678 failed", { email: "nam@gmail.com", phone: 912345678, txn: "TX1" }, new Error("smtp nam@gmail.com")),
    { maskPii: true }
  );
  assert.equal(entry.message, 'send to 091****678 failed {"email":"n***@gmail.com","phone":"912****678","txn":"TX1"}');
  assert.equal(entry.error_message, "smtp n***@gmail.com");
  assert.equal("request_id" in entry, false);
});

test("exported helpers", () => {
  const { maskPhoneOrEmail, maskPii, maskUrl } = require("../src");
  assert.equal(maskPhoneOrEmail("nam@gmail.com"), "n***@gmail.com");
  assert.equal(maskPhoneOrEmail("+84 912 345 678"), "849****678");
  assert.equal(maskPhoneOrEmail("abc"), "abc");
  assert.equal(maskPii('{"user":"a","email":"nam@gmail.com"}'), '{"user":"a","email":"n***@gmail.com"}');
  assert.equal(
    maskUrl("/v1/users/0912345678/info?token=abcd&email=nam%40gmail.com&p=1"),
    "/v1/users/091****678/info?token=[REDACTED]&email=n***@gmail.com&p=1"
  );
});

test("redaction stays linear on long inputs", () => {
  const { redactSecretsInText, maskPii } = require("../src");
  const start = Date.now();
  redactSecretsInText("password".repeat(50000));
  redactSecretsInText("x".repeat(400000));
  maskPii(`${"a".repeat(400000)}@`);
  maskPii("1 ".repeat(200000));
  assert.ok(Date.now() - start < 1000, `took ${Date.now() - start}ms`);
});

test("text redaction follows the same key rules, including custom keys", async () => {
  const entry = await one((l) => l.info('kyc cccd=0123 body {"cccd":"0123","idNumber":9} ok'), { redactKeys: ["cccd", "id_number"] });
  assert.equal(entry.message, 'kyc cccd=[REDACTED] body {"cccd":"[REDACTED]","idNumber":"[REDACTED]"} ok');
});

test("query value is redacted up to the next & even with , or ;", async () => {
  assert.equal((await one((l) => l.info("q password=a,b;c&x=1"))).message, "q password=[REDACTED]&x=1");
});

test("header-style lines and inspect-style values are redacted", async () => {
  const entry = await one((l) =>
    l.info("headers:\nCookie: sid=1; token=2\nX-Api-Key: k\nAccept: */*\n{ password: 'x', user: 'a', accessToken: abc }")
  );
  assert.equal(
    entry.message,
    "headers:\nCookie: [REDACTED]\nX-Api-Key: [REDACTED]\nAccept: */*\n{ password: '[REDACTED]', user: 'a', accessToken: [REDACTED] }"
  );
});

test("schema string fields set by callers are redacted and size-capped", async () => {
  const entry = await one(
    (l) => l.error("x", { errorCode: "token=abc", targetService: "y".repeat(500), userId: "0912345678" }),
    { maxMessageBytes: 100, maskPii: true }
  );
  assert.equal(entry.error_code, "token=[REDACTED]");
  assert.match(entry.target_service, /^y{100}…\[truncated 400 bytes\]$/);
  // id dạng số không bị che như SĐT
  assert.equal(entry.user_id, "0912345678");
});

test("environment is optional in the schema when NODE_ENV is unknown", async () => {
  const ctx = setup({ environment: "qa" });
  ctx.logger.info("x");
  const [entry] = await ctx.entries();
  assert.equal("environment" in entry, false);
  assert.ok(validate(entry), JSON.stringify(validate.errors));
});

test("whole JSON line stays under the line limit", async () => {
  const ctx = setup({ maxLineBytes: 16000 });
  const long = 'line "quoted"\n\t'.repeat(2000); // nhiều ký tự escape
  const err = new Error(long);
  ctx.logger.error(long, err, { targetService: "z".repeat(9000) });
  await flush();
  assert.equal(ctx.lines.length, 1);
  assert.ok(Buffer.byteLength(ctx.lines[0]) <= 16000, `line is ${Buffer.byteLength(ctx.lines[0])} bytes`);
  const entry = JSON.parse(ctx.lines[0]);
  assert.ok(validate(entry), JSON.stringify(validate.errors));
  assert.match(entry.error_stack, /^Error: line/);
});

test("concatenated key names are sensitive", async () => {
  const entry = await one((l) => l.info('q apikey=1&accesstoken=2&newpassword=3&x=4 {"clientsecret":"s","a":1}'));
  assert.equal(entry.message, 'q apikey=[REDACTED]&accesstoken=[REDACTED]&newpassword=[REDACTED]&x=4 {"clientsecret":"[REDACTED]","a":1}');
  const meta = await one((l) => l.info("m", { apikey: "1", clientsecret: "2", sessionid: "3", spin: "ok" }));
  assert.equal(meta.message, 'm {"apikey":"[REDACTED]","clientsecret":"[REDACTED]","sessionid":"[REDACTED]","spin":"ok"}');
});

test("a non-sensitive pair does not hide a sensitive pair after it", async () => {
  assert.equal((await one((l) => l.info("a=1;token=x"))).message, "a=1;token=[REDACTED]");
  assert.equal((await one((l) => l.info("a=1,password=x b=2"))).message, "a=1,password=[REDACTED] b=2");
  assert.equal((await one((l) => l.info("note: 'password: x', user: 'a'"))).message, "note: 'password: [REDACTED]', user: 'a'");
});

test("a secret longer than the pre-cut window is still redacted", async () => {
  const secret = "s".repeat(40000);
  const entry = await one((l) => l.info(`{"password":"${secret}","a":1}`));
  assert.doesNotMatch(entry.message, /sss/);
  assert.match(entry.message, /^\{"password":"\[REDACTED\]"/);
  const escaped = await one((l) => l.info(JSON.stringify(JSON.stringify({ token: secret }))));
  assert.doesNotMatch(escaped.message, /sss/);
});

test("long request_id from a header is capped", async () => {
  const ctx = setup();
  rTracer.runWithId(() => ctx.logger.info("x"), "r".repeat(20000));
  await flush();
  assert.ok(Buffer.byteLength(ctx.lines[0]) <= 16000);
  const [entry] = ctx.lines.map((line) => JSON.parse(line));
  assert.ok(Buffer.byteLength(entry.request_id) < 300);
  assert.ok(validate(entry), JSON.stringify(validate.errors));
});

test("a cut right after a backslash still redacts the value", () => {
  const { redactSecretsInText } = require("../src");
  assert.equal(redactSecretsInText('{"password":"abc\\'), '{"password":"[REDACTED]"');
  assert.equal(redactSecretsInText('{\\"token\\":\\"abc\\'), '{\\"token\\":\\"[REDACTED]\\"');
});

// điểm cắt thô của finalize (4 x maxMessageBytes) rơi ở các vị trí khác nhau quanh dấu \
test("pre-cut landing after a backslash does not leak the secret", async () => {
  for (const pad of [0, 1, 2, 3]) {
    const secret = `${"a".repeat(pad)}${"\\x".repeat(20000)}`;
    const entry = await one((l) => l.info(`{"password":"${secret}"}`), { maxMessageBytes: 1000 });
    assert.doesNotMatch(entry.message, /\\x\\x/, `pad ${pad}`);
  }
});

test("quoted key=value and key: \"value\" are redacted", () => {
  const { redactSecretsInText } = require("../src");
  assert.equal(
    redactSecretsInText(`cfg password="se cret" token='abc' user="a" pin: "1234" note: "ok"`),
    `cfg password="[REDACTED]" token='[REDACTED]' user="a" pin: "[REDACTED]" note: "ok"`
  );
  assert.equal(redactSecretsInText('x password="unterminated sec'), 'x password="[REDACTED]"');
});

test("line fitting continues until the record fits", async () => {
  const ctx = setup({ maxLineBytes: 16000 });
  const meta = {};
  const names = ["eventName", "targetService", "messagingSystem", "messagingDestination", "messageId", "jobName", "jobRunId", "errorCode", "logger", "serviceVersion", "userId", "accountId", "subAccountId", "orderId", "transactionId", "requestId"];
  for (const name of names) meta[name] = "v".repeat(8000);
  ctx.logger.error("m".repeat(8000), new Error("e".repeat(8000)), meta);
  await flush();
  assert.ok(Buffer.byteLength(ctx.lines[0]) <= 16000, `line is ${Buffer.byteLength(ctx.lines[0])} bytes`);
  assert.ok(validate(JSON.parse(ctx.lines[0])), JSON.stringify(validate.errors));
});

test("quoted values inside serialized meta (escaped quotes) are redacted", async () => {
  const entry = await one((l) => l.info("m", { note: `cfg password="x y" pin: "1234" token='a b' user="u"` }));
  const note = JSON.parse(entry.message.slice(2)).note;
  assert.equal(note, `cfg password="[REDACTED]" pin: "[REDACTED]" token='[REDACTED]' user="u"`);
  const { redactSecretsInText } = require("../src");
  assert.equal(redactSecretsInText('x password=\\"unterminated sec'), 'x password=\\"[REDACTED]\\"');
});

test("escaped quote inside a serialized secret does not end the value early", async () => {
  const entry = await one((l) => l.info("m", { note: 'cfg password="a\\"b c" user="u"' }));
  const note = JSON.parse(entry.message.slice(2)).note;
  assert.equal(note, 'cfg password="[REDACTED]" user="u"');
  const backslash = await one((l) => l.info("m", { note: 'cfg token="a\\\\" user="u"' }));
  assert.equal(JSON.parse(backslash.message.slice(2)).note, 'cfg token="[REDACTED]" user="u"');
});

test("call field replaces child field, valid or invalid", async () => {
  const a = await one((l) => l.child({ httpStatusCode: 200 }).info("x", { httpStatusCode: "unknown" }));
  assert.equal("http_status_code" in a, false);
  assert.equal(a.http_status_code_invalid, "unknown");
  const b = await one((l) => l.child({ httpStatusCode: "unknown" }).info("x", { httpStatusCode: 201 }));
  assert.equal(b.http_status_code, 201);
  assert.equal("http_status_code_invalid" in b, false);
});

test("long service name is capped", async () => {
  const ctx = setup({ service: "s".repeat(20000) });
  ctx.logger.info("x");
  await flush();
  assert.ok(Buffer.byteLength(ctx.lines[0]) <= 16000);
  const entry = JSON.parse(ctx.lines[0]);
  assert.ok(Buffer.byteLength(entry.service) < 300);
  assert.ok(validate(entry), JSON.stringify(validate.errors));
});

test("invalid caller field is not overridden by the value derived from the error", async () => {
  const err = new Error("x");
  err.statusCode = 503;
  const entry = await one((l) => l.error("upstream", err, { httpStatusCode: "unknown" }));
  assert.equal("http_status_code" in entry, false);
  assert.equal(entry.http_status_code_invalid, "unknown");
});

test("assignments with whitespace around = are redacted", () => {
  const { redactSecretsInText } = require("../src");
  assert.equal(
    redactSecretsInText('cfg password = "secret" token\t=\tabc user = "u" pin=[1234]'),
    'cfg password = "[REDACTED]" token\t=\t[REDACTED] user = "u" pin=[REDACTED]'
  );
});

test("tail after an already-redacted value is redacted too", () => {
  const { redactSecretsInText } = require("../src");
  assert.equal(
    redactSecretsInText("token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln!tail&x=1"),
    "token=[REDACTED]&x=1"
  );
  assert.equal(redactSecretsInText("x pin: [REDACTED] ok"), "x pin: [REDACTED] ok");
});

test("a non-sensitive key does not swallow the separator before the next pair", () => {
  const { redactSecretsInText } = require("../src");
  assert.equal(redactSecretsInText("a = token=x"), "a = token=[REDACTED]");
  assert.equal(redactSecretsInText("a: password: x"), "a: password: [REDACTED]");
  assert.equal(redactSecretsInText("a=token=x"), "a=token=[REDACTED]");
  assert.equal(redactSecretsInText("a:secret=x"), "a:secret=[REDACTED]");
});

test("container-valued JSON credentials are redacted", () => {
  const { redactSecretsInText } = require("../src");
  assert.equal(
    redactSecretsInText('{"password":{"value":"super]secret"},"token":["s1",{"x":"]"}],"a":{"b":1}}'),
    '{"password":"[REDACTED]","token":"[REDACTED]","a":{"b":1}}'
  );
  assert.equal(redactSecretsInText('m {\\"secret\\":{\\"v\\":\\"x}y\\"},\\"a\\":1}'), 'm {\\"secret\\":\\"[REDACTED]\\",\\"a\\":1}');
  assert.equal(redactSecretsInText('{"token":["unterminated'), '{"token":"[REDACTED]"');
});

test("minimal fallback respects a small line limit", async () => {
  const ctx = setup({ maxLineBytes: 512, service: "s".repeat(1000) });
  rTracer.runWithId(() => ctx.logger.info("m".repeat(5000), { targetService: "t".repeat(5000) }), "r".repeat(1000));
  await flush();
  // giới hạn bị kẹp lên tối thiểu 1024 byte
  assert.ok(Buffer.byteLength(ctx.lines[0]) <= 1024, `line is ${Buffer.byteLength(ctx.lines[0])} bytes`);
  assert.ok(validate(JSON.parse(ctx.lines[0])), JSON.stringify(validate.errors));
});

test("request_id from child metadata is normalized, capped and redacted", async () => {
  const num = await one((l) => l.child({ request_id: 123 }).info("x"));
  assert.equal(num.request_id, "123");
  const long = await one((l) => l.child({ request_id: `token=abc ${"r".repeat(5000)}` }).info("x"));
  assert.ok(Buffer.byteLength(long.request_id) < 300);
  assert.match(long.request_id, /^token=\[REDACTED\]/);
  const ctx = setup();
  rTracer.runWithId(() => ctx.logger.child({ request_id: "child" }).info("x"), "from-tracer");
  const [entry] = await ctx.entries();
  assert.equal(entry.request_id, "from-tracer");
});

test("JSON keys outside identifier syntax are redacted", () => {
  const { redactSecretsInText } = require("../src");
  assert.equal(
    redactSecretsInText('{"api key":"s1","2fa_token":"s2","Session Id":{"v":"s3"},"note":"ok"}'),
    '{"api key":"[REDACTED]","2fa_token":"[REDACTED]","Session Id":"[REDACTED]","note":"ok"}'
  );
  const longKey = `${"x".repeat(70)}_password`;
  assert.equal(redactSecretsInText(`{"${longKey}":"s"}`), `{"${longKey}":"[REDACTED]"}`);
  assert.equal(redactSecretsInText('{\\"api key\\":\\"s\\"}'), '{\\"api key\\":\\"[REDACTED]\\"}');
});

test("throwing error getters do not escape the logger", async () => {
  const err = new Error("boom");
  Object.defineProperty(err, "response", { get() { throw new Error("getter"); } });
  Object.defineProperty(err, "code", { get() { throw new Error("getter"); } });
  const entry = await one((l) => assert.doesNotThrow(() => l.error("x", err)));
  assert.equal(entry.message, "x");
  assert.equal(entry.error_type, "Error");
  const hostile = new Proxy(new Error("p"), { get(target, key) { if (key === "stack" || key === "message") return Reflect.get(target, key); throw new Error("trap"); } });
  await one((l) => assert.doesNotThrow(() => l.error(hostile)));
});

test("a broad non-sensitive JSON key does not hide a sensitive pair", () => {
  const { redactSecretsInText } = require("../src");
  assert.equal(
    redactSecretsInText('Invalid "user name": "{"password":"s"}"'),
    'Invalid "user name": "{"password":"[REDACTED]"}"'
  );
  assert.equal(redactSecretsInText('{"note":"x","otp":123456,"a":1.5e3}'), '{"note":"x","otp":"[REDACTED]","a":1.5e3}');
});

test("secrets in exceptions thrown while rendering are not logged", async () => {
  const err = new Error("boom");
  Object.defineProperty(err, "response", { get() { throw new Error("token=secret"); } });
  const ctx = setup();
  ctx.logger.error("x", err);
  await flush();
  assert.equal(ctx.lines.length, 1);
  assert.doesNotMatch(ctx.lines[0], /secret/);
});

test("bare values stop before an escaped quote and JSON pairs are scanned first", () => {
  const { redactSecretsInText } = require("../src");
  assert.equal(
    redactSecretsInText('{\\"q\\":\\"token=x\\",\\"password\\":\\"s\\"}'),
    '{\\"q\\":\\"token=[REDACTED]\\",\\"password\\":\\"[REDACTED]\\"}'
  );
  assert.equal(redactSecretsInText('x token=abc\\"tail'), 'x token=[REDACTED]\\"tail');
});
