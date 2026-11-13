const { expect } = require("chai");
require("ts-node/register/transpile-only");
const { ContentAnonimizer } = require("../src/core/anonymize-utils");
const { AnonymizeTransformer: Anonymize } = require("../src/core/anonymize-utils");
const router = require("../src/server/routes/anonymize-preview").default;
const handler = router.stack.find(layer => layer.route?.methods.post).route.stack[0].handle;

describe("POST /api/anonymize-preview preservation", () => {
  const content = "Jane Smith https://example.org ![Jane Smith](plot.png)";
  const options = { terms: ["Jane Smith", "Smith"], image: false, link: false };
  function request(body) {
    const res = { statusCode: 200, headers: {} };
    res.status = code => { res.statusCode = code; return res; };
    res.set = (key, value) => { res.headers[key] = value; return res; };
    res.json = body => { res.body = body; return res; };
    return handler({ body }, res).then(() => res);
  }
  for (const [filePath, preserveFiles] of [
    ["README.md", ["docs/"]], ["docs/README.md", ["docs/"]],
    ["paper/refs.bib", ["*.bib"]], ["paper/refs.bib", ["*.bib", "!/paper/refs.bib"]],
  ]) {
    it(`matches the production stream for ${filePath} with ${preserveFiles.join(", ")}`, async () => {
      const opt = { ...options, filePath, preserveFiles };
      const stream = new Anonymize(opt);
      let expected = "";
      stream.on("data", chunk => { expected += chunk.toString(); });
      const done = new Promise((resolve, reject) => { stream.on("end", resolve); stream.on("error", reject); });
      stream.end(content);
      await done;
      const res = await request({ content, options: opt });
      expect(res.body.content).to.equal(expected);
      expect(res.headers["Cache-Control"]).to.equal("private, no-store");
    });
  }
  it("keeps snippet batches working without a file path", async () => {
    const res = await request({ contents: [content, "Smith"], options });
    expect(res.body.contents).to.deep.equal([content, "Smith"].map(text => new ContentAnonimizer(options).anonymize(text)));
  });
  it("rejects malformed preservation rules and paths", async () => {
    for (const preserveFiles of ["*.bib", [42], ["../private"]]) {
      expect((await request({ content, options: { ...options, preserveFiles } })).statusCode).to.equal(400);
    }
    for (const filePath of ["../private", "/absolute", ["README.md"]]) {
      expect((await request({ content, options: { ...options, filePath } })).statusCode).to.equal(400);
    }
  });
});
