#!/usr/bin/env node

import { config as dot } from "dotenv";
dot();

import { writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import * as gh from "parse-github-url";
import * as inquirer from "inquirer";

import config from "./config";
import GitHubDownload from "./src/source/GitHubDownload";
import Repository from "./src/Repository";
import AnonymizedRepositoryModel from "./src/database/anonymizedRepositories/anonymizedRepositories.model";

function generateRandomFileName(size: number) {
  const characters =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < size; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

async function main() {
  config.STORAGE = "filesystem";
  const inq = await inquirer.prompt([
    {
      type: "string",
      name: "token",
      message: `Enter your GitHub token. You can create one at https://github.com/settings/personal-access-tokens/new.`,
      default: process.env.GITHUB_TOKEN,
    },
    {
      type: "string",
      name: "repo",
      message: `URL of the repository to anonymize (if you want to download a specific branch or commit use the GitHub URL of that branch or commit).`,
    },
    {
      type: "string",
      name: "terms",
      message: `Terms to remove from your repository (separated with comma).`,
    },
  ]);

  const ghURL = gh(inq.repo) || { owner: "", name: "", branch: "", commit: "" };

  const repository = new Repository(
    new AnonymizedRepositoryModel({
      repoId: "test",
      source: {
        type: "GitHubDownload",
        accessToken: inq.token,
        branch: ghURL.branch || "master",
        commit: ghURL.branch || "HEAD",
        repositoryName: `${ghURL.owner}/${ghURL.name}`,
      },
      options: {
        terms: inq.terms.split(","),
        expirationMode: "never",
        update: false,
        image: true,
        pdf: true,
        notebook: true,
        link: true,
        page: false,
      },
    })
  );

  const source = new GitHubDownload(
    {
      type: "GitHubDownload",
      accessToken: inq.token,
      repositoryName: inq.repo,
    },
    repository
  );

  console.info("[INFO] Downloading repository...");
  await source.download(inq.token);
  const outputFileName = join(tmpdir(), generateRandomFileName(8) + ".zip");
  console.info("[INFO] Anonymizing repository and creation zip file...");
  await writeFile(outputFileName, repository.zip());
  console.log(`Anonymized repository saved at ${outputFileName}`);
}

if (require.main === module) {
  if (process.argv[2] == "server") {
    // start the server
    require("./src/server").default();
  } else {
    // use the cli interface
    main();
  }
}
