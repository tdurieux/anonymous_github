const opentelemetry = require("@opentelemetry/sdk-node");
const {
  getNodeAutoInstrumentations,
} = require("@opentelemetry/auto-instrumentations-node");
const {
  OTLPTraceExporter,
} = require("@opentelemetry/exporter-trace-otlp-grpc");
const {
  OTLPMetricExporter,
} = require("@opentelemetry/exporter-metrics-otlp-grpc");
const { PeriodicExportingMetricReader } = require("@opentelemetry/sdk-metrics");
const { diag, DiagConsoleLogger, DiagLogLevel } = require("@opentelemetry/api");

// diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);

const sdk = new opentelemetry.NodeSDK({
  serviceName: process.env.SERVICE_NAME || "Anonymous-GitHub",
  logRecordProcessor: getNodeAutoInstrumentations().logRecordProcessor,
  traceExporter: new OTLPTraceExporter({
    url: "http://opentelemetry:4317/v1/traces",
  }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: "http://opentelemetry:4317/v1/metrics",
    }),
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});
sdk.start();
