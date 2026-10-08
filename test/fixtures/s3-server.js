const http = require("node:http");
const { URL } = require("node:url");
const objects = new Map();
module.exports = async function s3Fixture() {
  objects.clear();
  const requests = { lists: 0, deletions: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const key = decodeURIComponent(url.pathname).split("/").slice(2).join("/");
    if (req.method === "POST" && url.searchParams.has("delete")) {
      const chunks = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        const keys = [...body.matchAll(/<Key>(.*?)<\/Key>/g)].map(match => match[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
        requests.deletions.push(keys);
        keys.forEach(name => objects.delete(name));
        res.setHeader("Content-Type", "application/xml");
        res.end('<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>');
      });
      return;
    }
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
      requests.lists++;
      const escaped = value => value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      const remaining = [...objects].filter(([name]) => name.startsWith(prefix) && name > (url.searchParams.get("continuation-token") || "")).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      const page = remaining.slice(0, Number(url.searchParams.get("max-keys") || 1000));
      const truncated = remaining.length > page.length;
      const contents = page.map(([name, body]) => `<Contents><Key>${escaped(name)}</Key><Size>${body.length}</Size></Contents>`).join("");
      res.setHeader("Content-Type", "application/xml");
      res.end(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${escaped(page.at(-1)[0])}</NextContinuationToken>` : ""}${contents}</ListBucketResult>`); return;
    }
    if (!objects.has(key)) { res.statusCode = 404; res.end("<Error><Code>NoSuchKey</Code></Error>"); return; }
    const body = objects.get(key);
    res.setHeader("Content-Length", body.length); res.setHeader("Content-Type", "text/plain");
    res.setHeader("Last-Modified", new Date(0).toUTCString());
    if (req.method === "HEAD") res.end(); else res.end(body);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { endpoint: `http://127.0.0.1:${server.address().port}`, requests, seed: (key, data) => objects.set(key, Buffer.from(data)), close: () => new Promise(resolve => server.close(resolve)) };
};
