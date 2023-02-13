module.exports = {
  apps: [
    {
      name: "AnonymousGitHub",
      script: "./index.ts",
      exec_mode: "fork",
      watch: true,
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
      interpreter_args: "--require ts-node/register",
    },
  ],
};
