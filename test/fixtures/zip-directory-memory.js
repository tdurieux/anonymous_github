// Exercise real library directory encoding without spending minutes compressing
// file bodies: these are the same completed entries held at finalization.
const { setTimeout } = require("timers");
const { Writable } = require("stream");
const { once } = require("events");
const Entry = require("compress-commons/lib/archivers/zip/zip-archive-entry");
const { boundedZip } = require("../../build/core/bounded-zip");
(async () => {
  const archive = boundedZip();
  const engine = archive._module.engine;
  let centralRecords = 0, zip64Count = 0, pending = Buffer.alloc(0);
  const sink = new Writable({ highWaterMark: 1024, write(chunk, _encoding, done) {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const signature = pending.readUInt32LE(0);
      let length;
      if (signature === 0x02014b50) {
        if (pending.length < 46) break;
        length = 46 + pending.readUInt16LE(28) + pending.readUInt16LE(30) + pending.readUInt16LE(32);
        if (pending.length < length) break;
        centralRecords++;
      } else if (signature === 0x06064b50) {
        if (pending.length < 56) break;
        length = 56; zip64Count = Number(pending.readBigUInt64LE(32));
      } else if (signature === 0x07064b50) length = 20;
      else if (signature === 0x06054b50) length = 22;
      else throw new Error("invalid ZIP directory signature");
      if (pending.length < length) break;
      pending = pending.subarray(length);
    }
    setTimeout(done, 1);
  } });
  archive.pipe(sink);
  const finished = once(sink, "finish");
  const entries = 180636;
  for (let i = 0; i < entries; i++) {
    const entry = new Entry(`file-${i}.txt`); entry.setMethod(0); entry.setTime(new Date("2020-01-01")); entry._offsets = { file: 0 };
    engine._entries.push(entry);
  }
  await archive.finalize(); await finished;
  if (pending.length) throw new Error("incomplete directory");
  console.log(JSON.stringify({ entries, centralRecords, zip64Count, heapMiB: process.memoryUsage().heapUsed / 1048576 }));
})().catch(error => { console.error(error); process.exitCode = 1; });
