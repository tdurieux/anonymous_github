import { Branch } from "../types";
import * as gh from "parse-github-url";
import { RestEndpointMethodTypes } from "@octokit/rest";
import { trace } from "@opentelemetry/api";

import AnonymousError from "../AnonymousError";
import { isConnected } from "../../server/database";
import { octokit } from "../GitHubUtils";
import { IRepositoryDocument } from "../model/repositories/repositories.types";
import RepositoryModel from "../model/repositories/repositories.model";

export class GitHubRepository {
  private _data: Partial<{
    [P in keyof IRepositoryDocument]: IRepositoryDocument[P];
  }>;
  constructor(
    data: Partial<{ [P in keyof IRepositoryDocument]: IRepositoryDocument[P] }>
  ) {
    this._data = data;
  }

  toJSON() {
    return {
      id: this.model._id,
      externalId: this._data.externalId,
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

  public get fullName(): string | undefined {
    return this._data.name;
  }

  public get id(): string | undefined {
    return this._data.externalId;
  }

  public get size(): number | undefined {
    return this._data.size;
  }

  async getCommitInfo(
    sha: string,
    opt: {
      accessToken: string;
    }
  ) {
    const span = trace
      .getTracer("ano-file")
      .startSpan("GHRepository.getCommitInfo");
    span.setAttribute("owner", this.owner);
    span.setAttribute("repo", this.repo);
    try {
      const oct = octokit(opt.accessToken);
      const commit = await oct.repos.getCommit({
        owner: this.owner,
        repo: this.repo,
        ref: sha,
      });
      return commit.data;
    } finally {
      span.end();
    }
  }

  async branches(opt: {
    accessToken: string;
    force?: boolean;
  }): Promise<Branch[]> {
    const span = trace.getTracer("ano-file").startSpan("GHRepository.branches");
    span.setAttribute("owner", this.owner);
    span.setAttribute("repo", this.repo);
    try {
      if (
        !this._data.branches ||
        this._data.branches.length == 0 ||
        opt?.force === true
      ) {
        // get the list of repo from github
        const oct = octokit(opt.accessToken);
        try {
          const branches = (
            await oct.paginate("GET /repos/{owner}/{repo}/branches", {
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
          if (isConnected) {
            await RepositoryModel.updateOne(
              { externalId: this.id },
              { $set: { branches } }
            );
          }
        } catch (error) {
          span.recordException(error as Error);
          throw new AnonymousError("repo_not_found", {
            httpStatus: (error as any).status,
            cause: error as Error,
            object: this,
          });
        }
      } else if (isConnected) {
        const q = await RepositoryModel.findOne({ externalId: this.id }).select(
          "branches"
        );
        this._data.branches = q?.branches;
      }

      return this._data.branches || [];
    } finally {
      span.end();
    }
  }

  async readme(opt: {
    branch?: string;
    force?: boolean;
    accessToken: string;
  }): Promise<string | undefined> {
    const span = trace.getTracer("ano-file").startSpan("GHRepository.readme");
    span.setAttribute("owner", this.owner);
    span.setAttribute("repo", this.repo);
    try {
      if (!opt.branch) opt.branch = this._data.defaultBranch || "master";

      const model = await RepositoryModel.findOne({
        externalId: this.id,
      }).select("branches");

      if (!model) {
        throw new AnonymousError("repo_not_found", { httpStatus: 404 });
      }

      this._data.branches = await this.branches(opt);
      model.branches = this._data.branches;

      const selected = model.branches.filter((f) => f.name == opt.branch)[0];
      if (selected && (!selected.readme || opt?.force === true)) {
        // get the list of repo from github
        const oct = octokit(opt.accessToken);
        try {
          const ghRes = await oct.repos.getReadme({
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
          span.recordException(error as Error);
          throw new AnonymousError("readme_not_available", {
            httpStatus: 404,
            cause: error as Error,
            object: this,
          });
        }
      }

      if (!selected) {
        throw new AnonymousError("readme_not_available", {
          httpStatus: 404,
          object: this,
        });
      }

      return selected.readme;
    } finally {
      span.end();
    }
  }

  public get owner(): string {
    if (!this.fullName) {
      throw new AnonymousError("invalid_repo", {
        httpStatus: 400,
        object: this,
      });
    }
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
    if (!this.fullName) {
      throw new AnonymousError("invalid_repo", {
        httpStatus: 400,
        object: this,
      });
    }
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
  repositoryID?: string;
  accessToken: string;
  force?: boolean;
}) {
  const span = trace
    .getTracer("ano-file")
    .startSpan("GHRepository.getRepositoryFromGitHub");
  span.setAttribute("owner", opt.owner);
  span.setAttribute("repo", opt.repo);
  try {
    if (opt.repo.indexOf(".git") > -1) {
      opt.repo = opt.repo.replace(".git", "");
    }
    let dbModel = null;
    if (opt.repositoryID) {
      dbModel = isConnected
        ? await RepositoryModel.findById(opt.repositoryID)
        : null;
      opt.owner = dbModel?.name?.split("/")[0] || opt.owner;
      opt.repo = dbModel?.name?.split("/")[1] || opt.repo;
    } else {
      dbModel = isConnected
        ? await RepositoryModel.findOne({
            name: opt.owner + "/" + opt.repo,
          })
        : null;
    }
    if (dbModel && !opt.force) {
      return new GitHubRepository(dbModel);
    }
    const oct = octokit(opt.accessToken);
    let r: RestEndpointMethodTypes["repos"]["get"]["response"]["data"];
    try {
      r = (
        await oct.repos.get({
          owner: opt.owner,
          repo: opt.repo,
        })
      ).data;
    } catch (error) {
      span.recordException(error as Error);
      throw new AnonymousError("repo_not_found", {
        httpStatus: (error as any).status,
        object: {
          owner: opt.owner,
          repo: opt.repo,
        },
        cause: error as Error,
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
    const model = dbModel || new RepositoryModel({ externalId: "gh_" + r.id });
    model.name = r.full_name;
    model.url = r.html_url;
    model.size = r.size;
    model.defaultBranch = r.default_branch;
    model.hasPage = r.has_pages;
    if (model.hasPage) {
      const ghPageRes = await oct.repos.getPages({
        owner: opt.owner,
        repo: opt.repo,
      });
      model.pageSource = ghPageRes.data.source;
    }
    if (isConnected) {
      await model.save();
    }
    return new GitHubRepository(model);
  } finally {
    span.end();
  }
}
