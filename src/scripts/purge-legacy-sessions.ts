import "dotenv/config";
import { createClient } from "redis";
import config from "../config";

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--apply")) throw new Error("Unknown option");
  const client = createClient({ socket: { host: config.REDIS_HOSTNAME, port: config.REDIS_PORT, reconnectStrategy: false } });
  client.on("error", () => {});
  try {
    await client.connect();
    let found = 0;
    let removed = 0;
    for await (const key of client.scanIterator({ MATCH: "anoGH_session:*", COUNT: 100 })) {
      const raw = await client.get(key);
      if (!raw) continue;
      let legacy = false;
      try {
        const value = JSON.parse(raw);
        legacy = !!value.passport?.user && typeof value.passport.user !== "string";
      } catch { legacy = true; }
      if (!legacy) continue;
      found++;
      if (args.includes("--apply")) {
        // Do not remove a session replaced since the scan read it.
        removed += Number(await client.eval(
          'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',
          { keys: [key], arguments: [raw] }
        ));
      }
    }
    process.stdout.write(JSON.stringify({ found, removed }) + "\n");
  } finally { if (client.isOpen) await client.quit(); }
}
main().catch(() => {
  process.stderr.write("Legacy session cleanup failed; check Redis configuration and connectivity.\n");
  process.exitCode = 1;
});
