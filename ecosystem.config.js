module.exports = {
  apps: [
    {
      name: "AnonymousGitHub",
      script: "./index.ts",
      exec_mode: "fork",
      watch: true,
      interpreter: "node",
      interpreter_args:
        "--require ts-node/register",
    },
  ],
};
