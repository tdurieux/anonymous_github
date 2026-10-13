const { expect } = require("chai");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

describe("owner alert migration deployment", function () {
  this.timeout(10000);
  function deploy(options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "owner-alert-deploy-"));
    const statePath = path.join(directory, "state.json"), logPath = path.join(directory, "calls.jsonl");
    fs.mkdirSync(path.join(directory, "scripts"));
    fs.copyFileSync(path.join(__dirname, "../scripts/deploy.sh"), path.join(directory, "scripts/deploy.sh"));
    fs.writeFileSync(statePath, JSON.stringify({ ...options }));
    fs.writeFileSync(path.join(directory, "docker"), `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2), state = JSON.parse(fs.readFileSync(process.env.TASK_DOCKER_STATE));
fs.appendFileSync(process.env.TASK_DOCKER_LOG, JSON.stringify(args) + "\\n");
const finish = (output = "", code = 0) => { fs.writeFileSync(process.env.TASK_DOCKER_STATE, JSON.stringify(state)); process.stdout.write(output); process.exit(code); };
if (args[0] === "image" && args[1] === "inspect") {
  if (args.some(a => a.includes("Labels"))) finish(state.badProtocol ? "<no value>" : "recipient-v1");
  finish(state.built ? "sha:new" : "sha:old");
}
if (args[0] === "inspect") {
  if (args.some(a => a.includes("Labels"))) finish("<no value>");
  if (args.includes("{{.State.Running}}")) finish(state.stopped && !state.refuseStop ? "false" : "true");
  finish("healthy");
}
if (args[0] === "compose") {
  if (args[1] === "build") { if (state.buildFails) finish("", 1); state.built = true; finish(); }
  if (args[1] === "stop") { state.stopped = true; finish(); }
  if (args[1] === "run") { if (state.reconcileFails) finish("", 1); state.reconciled = true; finish(); }
  if (args[1] === "up") { if (args.includes("streamer")) state.streamers = true; else state.api = true; finish(); }
  if (args[1] === "ps") {
    if (args.includes("-q")) finish(args.includes("streamer") ? "old-api\\nold-1\\nold-2\\nold-3\\nold-4\\n" : "new-api");
    if (args.includes("streamer")) finish(state.streamers ? "new-1\\nnew-2\\nnew-3\\nnew-4\\n" : "old-1\\nold-2\\nold-3\\nold-4\\n");
    finish();
  }
}
finish("unexpected docker call", 2);
`, { mode: 0o755 });
    try {
      const result = spawnSync("bash", [path.join(directory, "scripts/deploy.sh")], {
        encoding: "utf8", timeout: 8000,
        env: { ...process.env, PATH: directory + path.delimiter + process.env.PATH,
          FORCE: String(options.force ?? 1), STREAMER_REPLICAS: "4", TASK_DOCKER_STATE: statePath, TASK_DOCKER_LOG: logPath },
      });
      return { ...result, calls: fs.readFileSync(logPath, "utf8").trim().split("\n").map(line => JSON.parse(line)) };
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }

  it("stops and verifies every legacy writer before starting any migration-capable instance", () => {
    const result = deploy();
    expect(result.status, result.stderr).to.equal(0);
    const stop = result.calls.findIndex(args => args[0] === "compose" && args[1] === "stop");
    const up = result.calls.findIndex(args => args[0] === "compose" && args[1] === "up");
    expect(stop).to.be.greaterThan(-1); expect(up).to.be.greaterThan(stop);
    const reconcile = result.calls.findIndex(args => args[0] === "compose" && args[1] === "run");
    expect(reconcile).to.be.greaterThan(stop); expect(reconcile).to.be.lessThan(up);
    expect(result.calls[reconcile]).to.include("./build/scripts/reconcile-legacy-owner-alerts.js");
    const checked = result.calls.slice(stop + 1, up).filter(args => args[0] === "inspect").map(args => args.at(-1));
    expect(checked).to.deep.equal(["old-api", "old-1", "old-2", "old-3", "old-4"]);
    expect(result.calls[stop]).to.include.members(["anonymous_github", "streamer"]);
    expect(result.calls[up]).to.include.members(["--force-recreate", "streamer=4"]);
    const api = result.calls.findIndex(args => args[0] === "compose" && args[1] === "up" && args.at(-1) === "anonymous_github");
    expect(api).to.be.greaterThan(up);
    for (const name of ["new-1", "new-2", "new-3", "new-4"]) {
      expect(result.calls.slice(up + 1, api).some(args => args[0] === "inspect" && args.at(-1) === name)).to.equal(true);
    }
  });
  it("aborts before migration starts if a legacy writer remains running", () => {
    const result = deploy({ refuseStop: true });
    expect(result.status).not.to.equal(0);
    expect(result.stderr).to.include("still running");
    expect(result.calls.some(args => args[0] === "compose" && args[1] === "up")).to.equal(false);
  });
  it("keeps old containers running if the image build fails", () => {
    const result = deploy({ buildFails: true });
    expect(result.status).not.to.equal(0);
    expect(result.calls.some(args => args[0] === "compose" && ["stop", "up"].includes(args[1]))).to.equal(false);
  });
  it("keeps old containers running if the replacement lacks migration support", () => {
    const result = deploy({ badProtocol: true });
    expect(result.status).not.to.equal(0);
    expect(result.stderr).to.include("lacks recipient alert migration support");
    expect(result.calls.some(args => args[0] === "compose" && ["stop", "up"].includes(args[1]))).to.equal(false);
  });
  it("starts no application instance if rollback reconciliation cannot be prepared", () => {
    const result = deploy({ reconcileFails: true });
    expect(result.status).not.to.equal(0);
    expect(result.calls.some(args => args[0] === "compose" && args[1] === "up")).to.equal(false);
  });
  for (const stopped of [true, false]) it(`reconciles legacy ${stopped ? "stopped" : "running"} containers when the replacement was already built`, () => {
    const result = deploy({ built: true, stopped, force: 0 });
    expect(result.status, result.stderr).to.equal(0);
    const reconcile = result.calls.findIndex(args => args[0] === "compose" && args[1] === "run");
    const up = result.calls.findIndex(args => args[0] === "compose" && args[1] === "up");
    expect(reconcile).to.be.greaterThan(-1); expect(up).to.be.greaterThan(reconcile);
    expect(result.stdout).not.to.include("nothing to deploy");
  });
});
