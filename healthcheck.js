require("dotenv").config();
const http = require("http");
const config = require("./build/config");

const options = {
  path: "/healthcheck",
  method: "GET",
  host: "127.0.0.1",
  port: config.default.PORT,
  timeout: 2000,
};
const request = http.request(options, (res) => {
  if (res.statusCode == 200 || res.statusCode == 404) {
    process.exit(0);
  } else {
    const reqURL = `${res.req.protocol}://${res.req.host}:${options.port}${res.req.path}`;
    console.log(reqURL, res.statusCode);
    process.exit(1);
  }
});

request.on("error", (err) => {
  console.log("ERROR", err);
  process.exit(1);
});

request.end();
