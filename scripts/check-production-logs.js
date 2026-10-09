const { spawn, execFileSync } = require("node:child_process");
const { createInterface } = require("node:readline");

function logSummary() {
  return { completed: 0, interrupted: 0, completed5xx: 0, fatalErrors: 0, errors: 0,
    warnings: 0, tokenRefreshFailures: 0, missingFiles: 0, rateLimited: 0, connectionResets: 0 };
}
function observeLine(summary, line) {
  // Older releases rely on Node's stderr. New releases also emit a redacted
  // process_fatal_error event before Node terminates.
  if (/ECONNRESET|socket hang up/i.test(line)) summary.connectionResets++;
  const match = /^\S+ (INFO|WARN|ERROR) \[([^\]]+)\] .*? (\{.*\})$/.exec(line);
  if (!match) {
    if (/Unhandled ['"]error['"] event|unhandled(?:promise)?rejection|FATAL ERROR|heap out of memory/i.test(line)) summary.fatalErrors++;
    return;
  }
  let data;
  try { data = JSON.parse(match[3]); } catch { return; }
  const [, level, scope] = match;
  if (level === "ERROR") summary.errors++;
  if (level === "WARN") summary.warnings++;
  if (data.code === "process_fatal_error" || /startup failed/i.test(line)) summary.fatalErrors++;
  if (data.code === "token_refresh_failed") summary.tokenRefreshFailures++;
  if (scope === "anonymized-file" && data.code === "file_not_found") summary.missingFiles++;
  if (scope === "requests" && typeof data.ms === "number") {
    if (data.outcome === "completed") { summary.completed++; if (data.status >= 500) summary.completed5xx++; }
    else summary.interrupted++;
    if (data.status === 429) summary.rateLimited++;
  }
}
async function readLogs(name, since) {
  const summary = logSummary();
  const child = spawn("docker", ["logs", "--since", since, name], { stdio: ["ignore", "pipe", "pipe"] });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error("docker logs failed")));
  });
  for (const output of [child.stdout, child.stderr]) {
    createInterface({ input: output }).on("line", line => observeLine(summary, line));
  }
  await completion;
  return summary;
}
function containerSummary(container) {
  return { name: container.Name.replace(/^\//, ""), healthy: container.State.Health?.Status === "healthy",
    running: container.State.Running, restartCount: container.RestartCount,
    oomKilled: container.State.OOMKilled, startedAt: container.State.StartedAt };
}
async function main(minutes) {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error("Minutes must be between 1 and 1440");
  const since = new Date(Date.now() - minutes * 60000).toISOString();
  const names = execFileSync("docker", ["ps", "-a", "--filter", "label=com.docker.compose.project=anonymous_github", "--format", "{{.Names}}"], { encoding: "utf8" })
    .trim().split("\n").filter(name => /^anonymous_github-(anonymous_github|streamer)-\d+$/.test(name));
  if (!names.length) throw new Error("No application containers found");
  const containers = JSON.parse(execFileSync("docker", ["inspect", ...names], { encoding: "utf8" }));
  const services = [];
  for (const container of containers) services.push({ ...containerSummary(container), logs: await readLogs(container.Name, since) });
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), minutes, services }, null, 2));
}
module.exports = { logSummary, observeLine, containerSummary };
if (require.main === module) main(Number(process.argv[2] || 15)).catch(() => {
  console.error("Production log check failed; check Docker access and the requested window."); process.exitCode = 1;
});
