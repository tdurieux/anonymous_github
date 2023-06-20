module.exports = {
  apps: [
    {
      name: "AnonymousGitHub",
      script: "build/index.js",
      exec_mode: "fork",
      watch: false,
      ignore_watch: [
        "node_modules",
        "repositories",
        "repo",
        "public",
        ".git",
        "db_backups",
        "build",
      ],
      interpreter: "node",
    },
  ],
};
