const { Readable } = require("node:stream");
const path = require("node:path");
const compiled = process.env.PERFORMANCE_STREAMER_COMPILED === "1";
if (!compiled) require("ts-node/register/transpile-only");
const base = path.join(__dirname, compiled ? "../../build" : "../../src");
const GitHubStream = require(path.join(base, "core/source/GitHubStream")).default;
const FileSystem = require(path.join(base, "core/storage/FileSystem")).default;
const maintenance = require(path.join(base, "core/temporary-storage"));
const startMaintenance = maintenance.startTemporaryStorageMaintenance;
// Exercise the real startup/timer wiring without waiting a production minute.
maintenance.startTemporaryStorageMaintenance = () => startMaintenance(25);
const downloadWithFallback = GitHubStream.prototype.downloadWithFallback;
GitHubStream.prototype.downloadWithFallback = async function (token, sha, filePath) {
  if (filePath.startsWith("fail-")) {
    this.downloadFile = () => {
      const input = new Readable({ read() {} });
      const failure = Object.assign(new Error("fixture upstream failure"), filePath === "fail-reset.txt"
        ? { code: "ECONNRESET" } : { response: { statusCode: 401 } });
      process.nextTick(() => input.destroy(failure));
      return input;
    };
    return downloadWithFallback.call(this, token, sha, filePath);
  }
  process.send({ download: true });
  return Readable.from([Buffer.alloc(300000, "x")]);
};
const write = FileSystem.prototype.write;
let release, releaseConnection;
if (process.env.PERFORMANCE_HOLD_CONNECT === "1") {
  const database = require(path.join(base, "server/database")), connect = database.connect;
  database.connect = async (...args) => {
    const held = new Promise(resolve => { releaseConnection = resolve; });
    process.send({ connectionHeld: true }); await held;
    return connect(...args);
  };
}
FileSystem.prototype.write = async function (...args) {
  if (args[1].endsWith("/hold.txt")) {
    const held = new Promise(resolve => { release = resolve; });
    process.send({ held: true }); await held;
  }
  return write.apply(this, args);
};
if (process.env.CREDENTIAL_KEYS !== "invalid") process.on("message", message => {
  if (message === "release") release?.();
  if (message === "connect") releaseConnection?.();
  if (message === "inspect") {
    const options = require("mongoose").connection.getClient().options;
    process.send({ connected: require(path.join(base, "server/database")).isConnected,
      maxPoolSize: options.maxPoolSize, minPoolSize: options.minPoolSize });
  }
});
require(path.join(base, "streamer/index"));
