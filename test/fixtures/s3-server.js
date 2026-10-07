const http = require("node:http");
const { URL } = require("node:url");
const objects = new Map();
module.exports = async function s3Fixture() {
  objects.clear();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const key = decodeURIComponent(url.pathname).split("/").slice(2).join("/");
    if (req.method === "PUT") {
      const chunks = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        let body = Buffer.concat(chunks);
        if (req.headers["content-encoding"]?.includes("aws-chunked")) {
          const decoded = []; let offset = 0;
          while (offset < body.length) {
            const end = body.indexOf("\r\n", offset); if (end < 0) break;
            const size = parseInt(body.toString("ascii", offset, end).split(";")[0], 16);
            if (!size) break;
            decoded.push(body.subarray(end + 2, end + 2 + size)); offset = end + 2 + size + 2;
          }
          body = Buffer.concat(decoded);
        }
        if (key) objects.set(key, body);
        res.setHeader("ETag", '"fixture-etag"'); res.end();
      });
      return;
    }
    if (url.searchParams.has("list-type")) {
      const prefix = url.searchParams.get("prefix") || "";
      const escaped = value => value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      const contents = [...objects].filter(([name]) => name.startsWith(prefix)).map(([name, body]) => `<Contents><Key>${escaped(name)}</Key><Size>${body.length}</Size></Contents>`).join("");
      res.setHeader("Content-Type", "application/xml");
      res.end(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`); return;
    }
    if (!objects.has(key)) { res.statusCode = 404; res.end("<Error><Code>NoSuchKey</Code></Error>"); return; }
    const body = objects.get(key);
    res.setHeader("Content-Length", body.length); res.setHeader("Content-Type", "text/plain");
    res.setHeader("Last-Modified", new Date(0).toUTCString());
    if (req.method === "HEAD") res.end(); else res.end(body);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { endpoint: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
};
