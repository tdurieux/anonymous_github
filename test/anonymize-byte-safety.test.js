const { expect } = require("chai");
require("ts-node/register/transpile-only");
const { AnonymizeTransformer } = require("../src/core/anonymize-utils");

function runRaw(chunks, opt) {
  return new Promise((resolve, reject) => {
    const t = new AnonymizeTransformer(opt);
    const out = [];
    t.on("data", (b) => out.push(Buffer.from(b)));
    t.on("end", () => resolve(Buffer.concat(out)));
    t.on("error", reject);
    for (const chunk of chunks) {
      t.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    t.end();
  });
}

describe("AnonymizeTransformer byte safety", function () {
  // A binary file (or text with stray bytes) misclassified as text used to
  // round-trip through StringDecoder and lose its non-UTF-8 bytes — every
  // 0xC3 (invalid lead) became EF BF BD ("U+FFFD"). When no anonymization
  // happens, the original buffer should now come out unchanged.
  it("preserves invalid UTF-8 bytes when nothing matches", async function () {
    // 0xC3 0x28 is a classic invalid sequence: lead byte without
    // continuation. Mixed with valid ASCII so the file still passes the
    // filename text-check.
    const input = Buffer.concat([
      Buffer.from("hello "),
      Buffer.from([0xc3, 0x28, 0xff, 0xfe]),
      Buffer.from(" world"),
    ]);

    const out = await runRaw([input], {
      filePath: "fixture.txt",
      terms: ["zzzz"],
    });
    expect(out.equals(input)).to.equal(true);
  });

  it("preserves a UTF-16 BOM-like prefix when nothing matches", async function () {
    const input = Buffer.from([0xff, 0xfe, ...Buffer.from("payload")]);
    const out = await runRaw([input], {
      filePath: "fixture.txt",
      terms: [],
    });
    expect(out.equals(input)).to.equal(true);
  });

  it("still anonymizes valid UTF-8 text", async function () {
    const input = "hello Alice and Bob";
    const out = await runRaw([input], {
      filePath: "fixture.txt",
      terms: ["Alice"],
    });
    expect(out.toString("utf8")).to.equal("hello XXXX-1 and Bob");
  });

  it("preserves valid-UTF-8 bytes across many chunks when no anonymization", async function () {
    // Non-ASCII but valid UTF-8 (CRLF, em-dash, accented chars) split into
    // many small writes — exercises the OVERLAP-based slicing through the
    // lossless path.
    const seg = "plain — segment with CRLF\r\nDavó café résumé ";
    const big = Buffer.from(seg.repeat(500), "utf8");
    const chunks = [];
    for (let i = 0; i < big.length; i += 137) {
      chunks.push(big.slice(i, i + 137));
    }
    const out = await runRaw(chunks, {
      filePath: "fixture.txt",
      terms: ["nope"],
    });
    expect(out.equals(big)).to.equal(true);
  });

  // Mid-stream chunks that are lossy (invalid UTF-8 splitting across the
  // OVERLAP boundary) currently fall back to the encoded form — byte
  // alignment between the decoded text and the original bytes is impossible
  // to recover without per-character byte tracking. End-of-stream lossy
  // bytes are still preserved (covered by the tests above).

  it("encodes output when anonymization does change the text, even with invalid bytes elsewhere", async function () {
    // Anonymization happens; the price is that the invalid byte becomes the
    // UTF-8 replacement char in the encoded output. That's the documented
    // trade-off — only the no-change path is byte-preserving.
    const input = Buffer.concat([
      Buffer.from("Alice "),
      Buffer.from([0xc3, 0x28]),
      Buffer.from(" trailer"),
    ]);
    const out = await runRaw([input], {
      filePath: "fixture.txt",
      terms: ["Alice"],
    });
    expect(out.toString("utf8")).to.match(/^XXXX-1 .* trailer$/);
  });
});
