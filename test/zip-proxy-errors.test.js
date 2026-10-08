const { expect } = require("chai");
const express = require("express");
const compression = require("compression");
const { gunzipSync } = require("node:zlib");
const http = require("node:http");
const { PassThrough } = require("node:stream");
const got = require("got");
require("ts-node/register/transpile-only");
const config = require("../src/config").default;
const utils = require("../src/server/routes/route-utils");
const router = require("../src/server/routes/repository-public").default;

describe("ZIP proxy failures", function () {
  let restore, upstream, server;
  beforeEach(async function () {
    const previous = { download: config.ENABLE_DOWNLOAD, endpoint: config.STREAMER_ENTRYPOINT,
      getRepo: utils.getRepo, getUser: utils.getUser, stream: got.stream };
    restore = () => {
      config.ENABLE_DOWNLOAD = previous.download;
      config.STREAMER_ENTRYPOINT = previous.endpoint;
      utils.getRepo = previous.getRepo; utils.getUser = previous.getUser; got.stream = previous.stream;
    };
    config.ENABLE_DOWNLOAD = true;
    config.STREAMER_ENTRYPOINT = "http://streamer.test/";
    utils.getUser = async () => { throw new Error("anonymous"); };
    utils.getRepo = async () => ({ repoId: "test", options: {},
      model: { source: { repositoryName: "owner/repo", commit: "abc" } },
      countView: async () => {}, getToken: async () => "",
      generateAnonymizeTransformer: () => ({ opt: {} }),
    });
    upstream = new PassThrough();
    got.stream = () => upstream;
    const app = express(); app.use(compression({ filter: () => true })); app.use(router);
    server = await new Promise(resolve => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
  });
  afterEach(async function () {
    upstream.destroy(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); restore();
  });
  function request(onResponse, headers = {}) {
    return http.get(`http://127.0.0.1:${server.address().port}/test/zip`, { headers }, onResponse);
  }
  it("answers HEAD without counting a view, obtaining a token or starting a ZIP stream", async function () {
    utils.getRepo = async () => ({ repoId: "test", countView: () => { throw Error("view counted"); },
      getToken: () => { throw Error("token requested"); }, generateAnonymizeTransformer: () => { throw Error("transform requested"); } });
    got.stream = () => { throw Error("archive requested"); };
    const result = await new Promise((resolve, reject) => {
      http.request(`http://127.0.0.1:${server.address().port}/test/zip`, { method: "HEAD" }, res => {
        const chunks = []; res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      }).on("error", reject).end();
    });
    expect(result.status).to.equal(200);
    expect(result.headers["content-disposition"]).to.include("test.zip");
    expect(result.body.length).to.equal(0);
  });
  it("still denies HEAD when downloads are disabled", async function () {
    config.ENABLE_DOWNLOAD = false;
    const status = await new Promise((resolve, reject) => {
      http.request(`http://127.0.0.1:${server.address().port}/test/zip`, { method: "HEAD" }, res => {
        res.resume(); res.on("end", () => resolve(res.statusCode));
      }).on("error", reject).end();
    });
    expect(status).to.equal(403);
  });
  it("aborts a partial ZIP when the upstream fails after headers", async function () {
    const result = new Promise((resolve, reject) => {
      const client = request(response => {
        expect(response.statusCode).to.equal(200);
        response.once("data", () => upstream.destroy(new Error("upstream disconnected")));
        response.on("aborted", resolve);
        response.on("end", () => reject(new Error("truncated ZIP reported as complete")));
        response.on("error", () => {});
      });
      client.on("error", reject);
    });
    upstream.write(Buffer.from("PK partial archive"));
    await result;
  });
  it("finishes compressed JSON errors before any ZIP bytes are sent", async function () {
    const error = "unavailable".repeat(300);
    const result = new Promise((resolve, reject) => {
      request(response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => resolve({
          status: response.statusCode, encoding: response.headers["content-encoding"],
          body: JSON.parse(gunzipSync(Buffer.concat(chunks)).toString()),
        }));
      }, { "Accept-Encoding": "gzip" }).on("error", reject);
    });
    upstream.once("newListener", event => {
      if (event === "error") globalThis.queueMicrotask(() => upstream.destroy(Object.assign(new Error("unavailable"), {
        response: { statusCode: 503, body: JSON.stringify({ error }) },
      })));
    });
    expect(await result).to.deep.equal({ status: 502, encoding: "gzip", body: { error } });
  });
  it("keeps JSON errors before any ZIP bytes are sent", async function () {
    const result = new Promise((resolve, reject) => {
      request(response => {
        let body = ""; response.on("data", chunk => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
      }).on("error", reject);
    });
    // Fail only after the route has attached its upstream listener.
    upstream.once("newListener", event => {
      if (event === "error") globalThis.queueMicrotask(() => upstream.destroy(Object.assign(new Error("unavailable"), {
        response: { statusCode: 503, body: '{"error":"zip_not_available"}' },
      })));
    });
    expect(await result).to.deep.equal({ status: 502, body: { error: "zip_not_available" } });
  });
});
