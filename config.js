const config = {
  CLIENT_ID: null,
  CLIENT_SECRET: null,
  GITHUB_TOKEN: null,
  MAX_FILE_SIZE: 10 * 1024 * 1024, // in b
  MAX_REPO_SIZE: 8 * 1024, // in kb
  AUTH_CALLBACK: "http://localhost:5000/github/auth",
};
for (let conf in process.env) {
  if (config[conf] !== undefined) {
    config[conf] = process.env[conf];
  }
}
module.exports = config;
