#!/usr/bin/env node

import { config as dot } from "dotenv";
dot();
process.env.STORAGE = "filesystem";

import { writeFile } from "fs/promises";
import { join } from "path";

import * as gh from "parse-github-url";
import * as inquirer from "inquirer";

import server from "../server";
import config from "../config";
import GitHubDownload from "../core/source/GitHubDownload";
import Repository from "../core/Repository";
import AnonymizedRepositoryModel from "../core/model/anonymizedRepositories/anonymizedRepositories.model";
import { getRepositoryFromGitHub } from "../core/source/GitHubRepository";

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
    {
      type: "string",
      name: "output",
      message: `The output folder where to save the zipped repository.`,
      default: process.cwd(),
    },
  ]);

  const ghURL = gh(inq.repo) || {
    owner: undefined,
    name: undefined,
    branch: undefined,
    commit: undefined,
  };

  if (!ghURL.owner || !ghURL.name) {
    throw new Error("Invalid GitHub URL");
  }

  const ghRepo = await getRepositoryFromGitHub({
    accessToken: inq.token,
    owner: ghURL.owner,
    repo: ghURL.name,
    force: true,
  });
  const branches = await ghRepo.branches({
    accessToken: inq.token,
    force: true,
  });
  const branchToFind = inq.repo.includes(ghURL.branch)
    ? ghURL.branch
    : ghRepo.model.defaultBranch || "master";
  const branch = branches.find((b) => b.name === branchToFind);

  const repository = new Repository(
    new AnonymizedRepositoryModel({
      repoId: `${ghURL.name}-${branch?.name}`,
      source: {
        type: "GitHubDownload",
        accessToken: inq.token,
        branch: branchToFind,
        commit: branch?.commit || "HEAD",
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

  console.info(
    `[INFO] Downloading repository: ${repository.model.source.repositoryName} from branch ${repository.model.source.branch} and commit ${repository.model.source.commit}...`
  );
  await (repository.source as GitHubDownload).download(inq.token);
  const outputFileName = join(inq.output, generateRandomFileName(8) + ".zip");
  console.info("[INFO] Anonymizing repository and creation zip file...");
  await writeFile(outputFileName, await repository.zip());
  console.log(`Anonymized repository saved at ${outputFileName}`);
}

if (require.main === module) {
  if (process.argv[2] == "server") {
    // start the server
    server();
  } else {
    // use the cli interface
    main();
  }
}
