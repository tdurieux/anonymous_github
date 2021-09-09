import { Branch } from "../types";
import * as gh from "parse-github-url";
import { IRepositoryDocument } from "../database/repositories/repositories.types";
import { Octokit } from "@octokit/rest";
import RepositoryModel from "../database/repositories/repositories.model";
import AnonymousError from "../AnonymousError";

export class GitHubRepository {
  private _data: Partial<
    { [P in keyof IRepositoryDocument]: IRepositoryDocument[P] }
  >;
  constructor(
    data: Partial<{ [P in keyof IRepositoryDocument]: IRepositoryDocument[P] }>
  ) {
    this._data = data;
  }

  toJSON() {
    return {
      repo: this.repo,
      owner: this.owner,
      hasPage: this._data.hasPage,
      pageSource: this._data.pageSource,
      fullName: this.fullName,
      defaultBranch: this._data.defaultBranch,
      size: this.size,
    };
  }

  get model() {
    return this._data;
  }

  public get fullName(): string {
    return this._data.name;
  }

  public get id(): string {
    return this._data.externalId;
  }

  public get size(): number {
    return this._data.size;
  }

  async branches(opt: {
    accessToken?: string;
    force?: boolean;
  }): Promise<Branch[]> {
    if (
      !this._data.branches ||
      this._data.branches.length == 0 ||
      opt?.force === true
    ) {
      // get the list of repo from github
      const octokit = new Octokit({ auth: opt.accessToken });
      const branches = (
        await octokit.paginate(octokit.repos.listBranches, {
          owner: this.owner,
          repo: this.repo,
          per_page: 100,
        })
      ).map((b) => {
        return {
          name: b.name,
          commit: b.commit.sha,
          readme: this._data.branches?.filter(
            (f: Branch) => f.name == b.name
          )[0]?.readme,
        } as Branch;
      });
      this._data.branches = branches;

      await RepositoryModel.updateOne(
        { externalId: this.id },
        { $set: { branches } }
      );
    } else {
      this._data.branches = (
        await RepositoryModel.findOne({ externalId: this.id }).select(
          "branches"
        )
      ).branches;
    }

    return this._data.branches;
  }

  async readme(opt: {
    branch?: string;
    force?: boolean;
    accessToken?: string;
  }): Promise<string> {
    if (!opt.branch) opt.branch = this._data.defaultBranch || "master";

    const model = await RepositoryModel.findOne({
      externalId: this.id,
    }).select("branches");

    this._data.branches = await this.branches(opt);
    model.branches = this._data.branches;

    const selected = model.branches.filter((f) => f.name == opt.branch)[0];
    if (selected && (!selected.readme || opt?.force === true)) {
      // get the list of repo from github
      const octokit = new Octokit({ auth: opt.accessToken });
      try {
        const ghRes = await octokit.repos.getReadme({
          owner: this.owner,
          repo: this.repo,
          ref: selected?.commit,
        });
        const readme = Buffer.from(
          ghRes.data.content,
          ghRes.data.encoding as BufferEncoding
        ).toString("utf-8");
        selected.readme = readme;
        await model.save();
      } catch (error) {
        throw new AnonymousError("readme_not_available", {
          httpStatus: 404,
          cause: error,
          object: this,
        });
      }
    }

    return selected.readme;
  }

  public get owner(): string {
    const repo = gh(this.fullName);
    if (!repo) {
      throw new AnonymousError("invalid_repo", {
        httpStatus: 400,
        object: this,
      });
    }
    return repo.owner || this.fullName;
  }

  public get repo(): string {
    const repo = gh(this.fullName);
    if (!repo) {
      throw new AnonymousError("invalid_repo", {
        httpStatus: 400,
        object: this,
      });
    }
    return repo.name || this.fullName;
  }
}

export async function getRepositoryFromGitHub(opt: {
  owner: string;
  repo: string;
  accessToken: string;
}) {
  if (opt.repo.indexOf(".git") > -1) {
    opt.repo = opt.repo.replace(".git", "");
  }
  const octokit = new Octokit({ auth: opt.accessToken });
  let r;
  try {
    r = (
      await octokit.repos.get({
        owner: opt.owner,
        repo: opt.repo,
      })
    ).data;
  } catch (error) {
    throw new AnonymousError("repo_not_found", {
      httpStatus: error.status,
      object: {
        owner: opt.owner,
        repo: opt.repo,
      },
      cause: error,
    });
  }
  if (!r)
    throw new AnonymousError("repo_not_found", {
      httpStatus: 404,
      object: {
        owner: opt.owner,
        repo: opt.repo,
      },
    });
  let model = await RepositoryModel.findOne({ externalId: "gh_" + r.id });
  if (!model) {
    model = new RepositoryModel({ externalId: "gh_" + r.id });
  }
  model.name = r.full_name;
  model.url = r.html_url;
  model.size = r.size;
  model.defaultBranch = r.default_branch;
  model.hasPage = r.has_pages;
  if (model.hasPage) {
    const ghPageRes = await octokit.repos.getPages({
      owner: opt.owner,
      repo: opt.repo,
    });
    model.pageSource = ghPageRes.data.source;
  }
  await model.save();
  return new GitHubRepository(model);
}
