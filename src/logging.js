const { createLogger, format, transports } = require("winston"),
  CloudWatchTransport = require("winston-aws-cloudwatch"),
  rTracer = require("cls-rtracer");

const { combine, timestamp, printf } = format;

var NODE_ENV = process.env.NODE_ENV || "development";
const rTracerFormat = printf((info) => {
  const rid = rTracer.id();

  //   if (typeof info.message === "object") {
  //     info.message = JSON.stringify(info.message, null, 3);
  //   }

  return rid
    ? `${info.timestamp} [request-id:${rid}]: ${info.message}`
    : `${info.timestamp}: ${info.message}`;
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

// AWS cloudwatch config for transporting logs to cloudwatch
var config = {
  logGroupName: process.env.LOG_GROUP_NAME || "unnamed-log-group",

  logStreamName: NODE_ENV,

  createLogGroup: true,

  createLogStream: true,

  awsConfig: {
    accessKeyId: process.env.CW_AWS_ACCESS_KEY_ID || "CW_AWS_ACCESS_KEY_ID",

    secretAccessKey:
      process.env.CW_AWS_SECRET_ACCESS_KEY || "CW_AWS_SECRET_ACCESS_KEY",

    region: process.env.AWS_REGION || "ap-southeast-1",
  },

  formatLog: function (item) {
    let reqId = rTracer.id();

    let reqIdText = reqId ? ": [request-id: " + reqId + "]" : "";

    return (
      item.meta.timestamp + " " + item.level + reqIdText + ": " + item.message
      // +
      //   " " +
      //   JSON.stringfy(item.meta)
    );
  },
};

// adding cloudwatch Transport to logger

logger.add(new CloudWatchTransport(config));

logger.level = process.env.LOG_LEVEL || "silly";

logger.stream = {
  write: function (message, encoding) {
    logger.info(message);
  },
};

exports.logger = logger;
