# @finhay/finhay-logger

Logger dùng chung cho các service Node.js của Finhay và FHSC. Mỗi lời gọi log ra **đúng một dòng JSON** trên stdout theo **Log JSON schema v1** ([src/log-schema-v1.json](src/log-schema-v1.json), cùng schema với FHSC), có `request_id` từ [cls-rtracer](https://www.npmjs.com/package/cls-rtracer) và `trace_id`/`span_id` từ OpenTelemetry.

```json
{"schema_version":"1.0.0","timestamp":"2026-11-07T08:00:00.000Z","level":"error","service":"products-vnsc-auth","environment":"prod","message":"NotificationController.tracking:","request_id":"700fd060-...","trace_id":"0af7651916cd43dd8448eb211c80319c","span_id":"b7ad6b7169203331","error_type":"Error","error_message":"boom","error_stack":"Error: boom\n    at ..."}
```

## Cài đặt

Package public trên npmjs.com, không cần token hay `.npmrc`:

```bash
npm i @finhay/finhay-logger
```

Hỗ trợ Node.js >= 12.17.

## Sử dụng

```javascript
const { logger } = require("@finhay/finhay-logger");

logger.info("User %s logged in", uid);
logger.error("NotificationController.tracking:", err);      // message "NotificationController.tracking:" + error_*
logger.error(err);                                            // message = err.message + error_*
logger.info("payload", { a: 1 });                             // message 'payload {"a":1}'
logger.info("request done", {                                 // field theo schema
  eventName: "http_request_completed",
  httpMethod: "GET",
  httpRoute: "/v1/users/:id",
  httpStatusCode: 200,
  durationMs: 12,
  outcome: "success",
});
logger.log("warn", "retry %d", 3);
```

Quy tắc xử lý đối số:

- Placeholder `%s %d %i %f %j %o %O %%` được thay. Object ra JSON một dòng, Error ra `Tên: message`.
- Đối số thừa là chuỗi/số được nối vào cuối message (giống `console.log`).
- Error đầu tiên (đối số thừa, trong placeholder, hoặc ở key `error` của meta) ra `error_type`, `error_message`, `error_stack` (kèm chuỗi `Caused by:` của `err.cause`), `error_code` (`err.errorCode` hoặc `err.code`) và `http_status_code` (`err.statusCode` hoặc `err.response.status` của axios). Config/header/body của axios không bao giờ được ghi.
- Object thường: key thuộc schema (camelCase hoặc snake_case, xem bảng dưới) thành field; key còn lại nối vào message dạng JSON. Lý do: không sinh field tuỳ ý trên Elasticsearch (xung đột mapping, phình field).
- Giá trị sai kiểu của field schema (vd `httpStatusCode: "abc"`) được giữ dạng chuỗi ở `<tên>_invalid`.
- Không sửa object/Error truyền vào, không ném lỗi vào code gọi (object vòng ra `"[Circular]"`).

Request-id: dùng middleware của `cls-rtracer` trong service (vd `app.use(rTracer.expressMiddleware({ useHeader: true }))`). Morgan: `app.use(morgan("combined", { stream: logger.stream }))`.

### Field

| Field | Nguồn |
|---|---|
| `schema_version` | `1.0.0` |
| `timestamp` | ISO 8601 UTC, lúc gọi log |
| `level` | `silly→trace`, `verbose→debug`, `debug`, `http→info`, `info`, `warn`, `error` |
| `service` | option `service`, `OTEL_SERVICE_NAME`, `SERVICE_NAME`, `npm_package_name`, rồi `unknown` |
| `environment` | `NODE_ENV`: `production/prod→prod`, `development/develop→develop`, `staging`, `local`, `test`. Giá trị khác thì bỏ field và logger mặc định ghi một dòng warn lúc khởi động |
| `request_id` | cls-rtracer, lấy lúc gọi |
| `trace_id`, `span_id` | span OpenTelemetry đang active, lấy lúc gọi; chỉ ghi khi đúng định dạng W3C, `trace_flags` không xuất |
| `error_*`, `http_status_code` | từ Error, không đè giá trị người gọi đặt |

Field schema nhận từ meta (camelCase → tên đầu ra): `eventName`, `durationMs`, `outcome`, `httpMethod`, `httpRoute`, `httpStatusCode`, `targetService`, `messagingSystem`, `messagingDestination`, `messageId`, `jobName`, `jobRunId`, `errorCode`, `logger`, `serviceVersion`, `userId`, `accountId`, `subAccountId`, `orderId`, `transactionId`, `requestId` (→ `business_request_id`; `request_id` chỉ lấy từ cls-rtracer).

### OpenTelemetry

Không cần cấu hình. Logger đọc span active bằng `@opentelemetry/api` nếu app có cài (peer dependency optional), nếu không thì đọc registry global của OTel API v1, nên chạy được cả khi OTel operator inject SDK qua annotation `instrumentation.opentelemetry.io/inject-nodejs`. Giá trị `trace_id`/`span_id` mà `@opentelemetry/instrumentation-winston` gắn vào bản ghi cũng được dùng.

`cls-rtracer` cần >= 2.6.4: bản 2.6.2/2.6.3 chạy cùng OTel SDK làm listener `res.on('finish')` gắn sau middleware không chạy.

### Che dữ liệu nhạy cảm

**Credential luôn được che** (lớp chặn dự phòng; service vẫn nên tự che trước khi log):

- Theo tên key, ở mọi object logger serialize (meta, tham số `%o/%j`, object log một mình, meta của `child()`): key có từ cuối là `password`, `passwd`, `pwd`, `passcode`, `pin`, `otp`, `secret`, `token`, `cookie`, `authorization`, `cvv`, `cvc`, `jwt`; hai từ cuối là `api key`, `private key`, `secret key`, `access key`, `biometric key`, `pin code`, `otp code`, `card number`, `code verifier`, `session id`; hoặc chứa từ `password`. Giá trị thành `[REDACTED]`, riêng boolean/null giữ nguyên (`otpFound: true`). Ví dụ che: `newPassword`, `accessToken`, `x-api-key`, `transactionPin`; không che: `tokenType`, `otpType`.
- Theo mẫu trong mọi field chuỗi (message, `error_*`, field schema do người gọi đặt, `<tên>_invalid`): `Bearer …`/`Basic …`, chuỗi dạng JWT, và giá trị đứng sau một key nhạy cảm (cùng luật key ở trên, kể cả key thêm) ở các dạng `key=value` (query/form, tới dấu `&`), `"key": "value"` (JSON, kể cả đã escape), `key: 'value'` (util.inspect) và dòng header `Cookie: …` (tới hết dòng). Che trước khi cắt độ dài.
- Thêm key: `LOG_REDACT_KEYS=cccd,id_number` hoặc option `redactKeys`.

Không bắt được bí mật trong văn bản tự do không có key (vd `` `OTP của bạn là ${otp}` ``).

**SĐT/email chỉ che khi bật** `LOG_MASK_PII=true` (option `maskPii`): email thành `n***@domain`, chuỗi 9-15 chữ số thành `091****678`, cả trong message, meta và lỗi. Mặc định tắt vì vận hành tra log theo SĐT/email, và chuỗi số dài (mã giao dịch, số tài khoản) cũng sẽ bị che.

Helper cho service tự che: `maskPhoneOrEmail(value)`, `maskPii(text)`, `maskUrl(url)`, `redactSecretsInText(text)`.

### Biến môi trường

| Biến | Mặc định | Ghi chú |
|---|---|---|
| `LOG_LEVEL` | `info` | |
| `LOG_FORMAT` | `json` (`text` khi `NODE_ENV` là `local`/`test`) | `text`: `<timestamp> <level> [request-id:<id>]: <message> {field}` + stack |
| `NODE_ENV` | | ra `environment` |
| `OTEL_SERVICE_NAME` / `SERVICE_NAME` | | ra `service` |
| `LOG_MAX_MESSAGE_BYTES` | `8192` | message và `error_message` dài hơn bị cắt, để cả dòng dưới giới hạn 16 KB của Docker |
| `LOG_MAX_STACK_BYTES` | `4096` | |
| `LOG_MAX_LINE_BYTES` | `16000` | giới hạn cả dòng JSON; vượt thì cắt tiếp field chuỗi lớn nhất |
| `LOG_MASK_PII` | tắt | `true` để che SĐT/email |
| `LOG_REDACT_KEYS` | | key cần che thêm, cách nhau bằng dấu phẩy |

Có thể tạo logger riêng: `createLogger({ level, format, service, environment, stream, transports, maskPii, redactKeys })`.

## Phát triển

```bash
npm ci
npm test
```

Test kiểm mọi bản ghi JSON với `src/log-schema-v1.json` (ajv). Đổi schema thì sửa `src/schema.js` và `src/log-schema-v1.json`, giữ đồng bộ với FHSC.

Phát hành: tăng `version` trong `package.json`, merge vào `master`, rồi đẩy tag trùng version (vd `v1.0.0`). Workflow `publish.yml` chạy test và publish lên npmjs.com bằng secret `NPM_TOKEN`.

## Nâng cấp từ 0.x

- Output đổi từ text sang JSON schema v1. Đặt `LOG_FORMAT=text` nếu cần giữ dạng cũ trong giai đoạn chuyển đổi.
- Level mặc định đổi từ `silly` sang `info`.
- Error truyền kèm (`logger.error("X:", err)`) không còn bị mất: chi tiết nằm ở `error_*`.
- Cài từ npm thay cho `git+https://github.com/finhay/finhay-nodejs-logger.git`. Bỏ `.npmrc`/token GitHub Packages và `apk add git` nếu chỉ dùng cho lib này.
