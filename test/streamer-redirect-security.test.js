const { expect } = require("chai");
const http = require("node:http");
const got = require("got");
require("ts-node/register/transpile-only");
const { streamResponse } = require("../src/core/response-stream");
const { rejectStreamerRedirects } = require("../src/core/streamer-response");
const { probeStreamerCache } = require("../src/core/streamer-cache-probe");

describe("streamer response isolation", function () {
  const servers = [];
  async function serve(handler) {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    })));
  });

  it("does not let Got copy identity-bearing upstream headers or status", async () => {
    const upstream = await serve((_req, res) => {
      res.writeHead(201, {
        Location: "https://github.com/private-owner/private-repository",
        Refresh: "0; url=https://github.com/private-owner/private-repository",
        "Content-Location": "/private-owner/private-repository",
        Link: "<https://github.com/private-owner/private-repository>; rel=canonical",
        "Set-Cookie": "owner=private-owner",
        "Content-Disposition": "attachment; filename=private-owner.zip",
      });
      res.end("anonymized content");
    });
    const proxy = await serve((_req, res) => {
      res.setHeader("Content-Type", "text/plain");
      void streamResponse(got.stream(upstream), res, () => res.end("error"));
    });
    const result = await got(proxy);
    expect(result.statusCode).to.equal(200);
    expect(result.body).to.equal("anonymized content");
    for (const header of ["location", "refresh", "content-location", "link", "set-cookie", "content-disposition"]) {
      expect(result.headers).not.to.have.property(header);
    }
  });

  for (const status of [301, 302, 303, 307, 308]) {
    it(`rejects ${status} without forwarding its body or contacting the destination`, async () => {
      let contacted = 0;
      const target = await serve((_req, res) => { contacted++; res.end("private-owner"); });
      const upstream = await serve((_req, res) => {
        res.writeHead(status, { Location: target + "/private-owner/private-repository" });
        res.end("private-owner/private-repository");
      });
      const proxy = await serve((_req, res) => {
        const source = rejectStreamerRedirects(got.stream(upstream, { followRedirect: false }));
        void streamResponse(source, res, () => { res.statusCode = 502; res.end("upstream_error"); });
      });
      const result = await got(proxy, { throwHttpErrors: false, retry: 0 });
      expect(result.statusCode).to.equal(502);
      expect(result.body).to.equal("upstream_error");
      expect(result.headers).not.to.have.property("location");
      let failure;
      try { await probeStreamerCache(upstream, {}, {}); } catch (error) { failure = error; }
      expect(failure).to.be.instanceOf(Error);
      expect(contacted).to.equal(0);
    });
  }
});
