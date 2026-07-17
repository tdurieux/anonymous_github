const { expect } = require("chai");
require("ts-node/register/transpile-only");

const {
  resolveTrustProxy,
  isCloudflareIP,
  CLOUDFLARE_IP_RANGES,
} = require("../src/server/trustProxy");

describe("trustProxy", function () {
  describe("resolveTrustProxy", function () {
    it("parses a plain integer as a legacy hop count", function () {
      expect(resolveTrustProxy("1")).to.equal(1);
      expect(resolveTrustProxy("2")).to.equal(2);
      expect(resolveTrustProxy(" 3 ")).to.equal(3);
    });

    it("parses zero as a number", function () {
      expect(resolveTrustProxy("0")).to.equal(0);
    });

    it("expands the cloudflare keyword to the published ranges", function () {
      const result = resolveTrustProxy("cloudflare");
      expect(result).to.be.an("array");
      expect(result).to.have.members([...CLOUDFLARE_IP_RANGES]);
    });

    it("keeps named subnets and mixes them with cloudflare ranges", function () {
      const result = resolveTrustProxy("loopback,uniquelocal,cloudflare");
      expect(result).to.include("loopback");
      expect(result).to.include("uniquelocal");
      expect(result).to.include("173.245.48.0/20");
      expect(result).to.include("2400:cb00::/32");
      expect(result).to.have.length(2 + CLOUDFLARE_IP_RANGES.length);
    });

    it("accepts literal CIDRs and trims whitespace and empty tokens", function () {
      const result = resolveTrustProxy(" 10.0.0.0/8 , , 192.168.1.1 ");
      expect(result).to.deep.equal(["10.0.0.0/8", "192.168.1.1"]);
    });

    it("is case-insensitive for the cloudflare keyword", function () {
      const result = resolveTrustProxy("Cloudflare");
      expect(result).to.have.length(CLOUDFLARE_IP_RANGES.length);
    });
  });

  describe("isCloudflareIP", function () {
    it("matches IPv4 addresses inside Cloudflare ranges", function () {
      expect(isCloudflareIP("104.16.132.229")).to.be.true; // 104.16.0.0/13
      expect(isCloudflareIP("172.64.0.1")).to.be.true; // 172.64.0.0/13
      expect(isCloudflareIP("173.245.48.10")).to.be.true; // 173.245.48.0/20
    });

    it("matches IPv6 addresses inside Cloudflare ranges", function () {
      expect(isCloudflareIP("2400:cb00::1")).to.be.true;
      expect(isCloudflareIP("2606:4700:4700::1111")).to.be.true;
    });

    it("matches IPv4-mapped IPv6 representations", function () {
      expect(isCloudflareIP("::ffff:104.16.0.1")).to.be.true;
    });

    it("rejects addresses outside Cloudflare ranges", function () {
      expect(isCloudflareIP("8.8.8.8")).to.be.false;
      expect(isCloudflareIP("127.0.0.1")).to.be.false;
      expect(isCloudflareIP("192.168.1.1")).to.be.false;
      expect(isCloudflareIP("2001:4860:4860::8888")).to.be.false;
      expect(isCloudflareIP("::ffff:8.8.8.8")).to.be.false;
    });

    it("rejects garbage input without throwing", function () {
      expect(isCloudflareIP("")).to.be.false;
      expect(isCloudflareIP("not-an-ip")).to.be.false;
      expect(isCloudflareIP("104.16.0")).to.be.false;
    });
  });

  describe("integration with Express trust proxy resolution", function () {
    const express = require("express");

    function requestIp(trustProxy, headers) {
      const app = express();
      app.set("trust proxy", trustProxy);
      let captured = null;
      app.get("/", (req, res) => {
        captured = req.ip;
        res.end();
      });
      return new Promise((resolve, reject) => {
        const server = app.listen(0, "127.0.0.1", () => {
          const { port } = server.address();
          const http = require("http");
          const req = http.get(
            { host: "127.0.0.1", port, path: "/", headers },
            (res) => {
              res.resume();
              res.on("end", () => {
                server.close();
                resolve(captured);
              });
            }
          );
          req.on("error", (err) => {
            server.close();
            reject(err);
          });
        });
      });
    }

    it("resolves the visitor IP through Cloudflare hops regardless of count", async function () {
      const trust = resolveTrustProxy("loopback,uniquelocal,cloudflare");
      // Simulate: visitor -> Cloudflare edge -> local nginx -> app, where
      // Cloudflare appended an extra internal hop to X-Forwarded-For.
      const ip = await requestIp(trust, {
        "x-forwarded-for": "203.0.113.7, 104.16.0.9, 172.64.0.3",
      });
      expect(ip).to.equal("203.0.113.7");
    });

    it("does not honour X-Forwarded-For from an untrusted public peer entry", async function () {
      const trust = resolveTrustProxy("loopback,uniquelocal,cloudflare");
      // The last entry is a non-Cloudflare public address: resolution stops
      // there, so a forged visitor entry further left is ignored.
      const ip = await requestIp(trust, {
        "x-forwarded-for": "1.2.3.4, 8.8.8.8",
      });
      expect(ip).to.equal("8.8.8.8");
    });

    it("legacy hop count still works", async function () {
      const ip = await requestIp(resolveTrustProxy("1"), {
        "x-forwarded-for": "203.0.113.7, 104.16.0.9",
      });
      // hop count 1 trusts only the direct peer, so req.ip is the last
      // X-Forwarded-For entry — the fragile behavior this change moves
      // away from.
      expect(ip).to.equal("104.16.0.9");
    });
  });
});
