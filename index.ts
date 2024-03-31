const cluster = require('node:cluster');
import { config } from "dotenv";
config();

import server from "./src/server";

if (cluster.isPrimary) {
  console.log(`Master process ${process.pid} is running`);

  for (let i = 0; i < 8; i++) {
    cluster.fork();
  }
} else {
  // start the server
  server();
}
