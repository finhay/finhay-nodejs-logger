const { createLogger, format, transports } = require("winston"),
  rTracer = require("cls-rtracer");

const { combine, timestamp, printf } = format;

// let NODE_ENV = process.env.NODE_ENV || "development";
const rTracerFormat = printf((info) => {
  const rid = rTracer.id();

  return rid
    ? `${info.timestamp} ${info.level} [request-id:${rid}]: ${info.message}`
    : `${info.timestamp} ${info.level}: ${info.message}`;
});

//creating the logger
const logger = createLogger({
  format: combine(timestamp(), format.splat(), rTracerFormat),

  transports: [
    new transports.Console({
      timestamp: true,

      colorize: true,
    }),
  ],
});

logger.level = process.env.LOG_LEVEL || "silly";

logger.stream = {
  write: function (message, encoding) {
    logger.info(message);
  },
};

exports.logger = logger;
