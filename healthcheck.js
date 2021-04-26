const http = require("http");
const config = require("./config");

const options = {
  host: "localhost",
  port: config.PORT,
  timeout: 2000,
};

const request = http.request(options, (res) => {
  if (res.statusCode == 200) {
    process.exit(0);
  } else {
    process.exit(1);
  }
});

request.on("error", (err) => {
  console.log("ERROR");
  process.exit(1);
});

request.end();
