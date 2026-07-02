const { expect } = require("chai");
require("ts-node/register/transpile-only");
const mongoose = require("mongoose");
const AnonymizedGistSchema = require("../src/core/model/anonymizedGists/anonymizedGists.schema").default;

/**
 * Regression test for the empty gist page bug.
 *
 * The `files` sub-document declared a data field literally named `type`
 * (`type: String`). Mongoose treats a bare `type` key as a type
 * declaration, so `gist.files` was compiled as an array of *strings*
 * instead of sub-documents. Every downloaded file object then failed
 * casting and was silently dropped, and gists were saved with
 * `gist.files: []` — rendering an empty gist page.
 */

describe("AnonymizedGistSchema gist.files", function () {
  const Model =
    mongoose.models.GistSchemaTest ||
    mongoose.model("GistSchemaTest", AnonymizedGistSchema);

  const files = [
    {
      filename: "a.txt",
      content: "hello world",
      language: "Text",
      size: 11,
      type: "text/plain",
    },
    {
      filename: "b.md",
      content: "# readme",
      language: "Markdown",
      size: 8,
      type: "text/markdown",
    },
  ];

  it("compiles gist.files as a sub-document array, not a string array", function () {
    const path = AnonymizedGistSchema.path("gist.files");
    expect(path.constructor.name).to.equal("DocumentArrayPath");
  });

  it("keeps file objects when set via sub-paths (download() flow)", function () {
    const doc = new Model({});
    doc.set("gist.files", files);
    expect(doc.gist.files).to.have.length(2);
    expect(doc.gist.files[0].filename).to.equal("a.txt");
    expect(doc.gist.files[0].content).to.equal("hello world");
    expect(doc.gist.files[0].type).to.equal("text/plain");
  });

  it("keeps file objects when passed to the constructor", function () {
    const doc = new Model({ gist: { files } });
    expect(doc.gist.files).to.have.length(2);
    expect(doc.gist.files[1].size).to.equal(8);
  });

  it("casts gist.files correctly in an updateOne $set (updateIfNeeded flow)", function () {
    const doc = new Model({});
    doc.set("gist.files", files);
    const query = Model.updateOne({ _id: doc._id }, { $set: { gist: doc.gist } });
    const casted = query._update.$set.gist;
    expect(casted.files).to.have.length(2);
    expect(casted.files[0].content).to.equal("hello world");
  });
});
