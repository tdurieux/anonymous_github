import { RepositoryStatus } from "./types";
import User from "./User";
import UserModel from "./model/users/users.model";
import Conference from "./Conference";
import ConferenceModel from "./model/conference/conferences.model";
import AnonymousError from "./AnonymousError";
import { IAnonymizedGistDocument } from "./model/anonymizedGists/anonymizedGists.types";
import config from "../config";
import { octokit } from "./GitHubUtils";
import { ContentAnonimizer } from "./anonymize-utils";

type GistPayload = {
  description: string;
  isPublic?: boolean;
  creationDate: Date;
  updatedDate: Date;
  ownerLogin?: string;
  files: {
    filename: string;
    content: string;
    language?: string;
    size: number;
    type?: string;
  }[];
  comments: {
    body: string;
    creationDate: Date;
    updatedDate: Date;
    author: string;
  }[];
};

export default class Gist {
  private _model: IAnonymizedGistDocument;
  private _gistPayload?: GistPayload;
  owner: User;

  constructor(data: IAnonymizedGistDocument) {
    this._model = data;
    this.owner = new User(new UserModel({ _id: data.owner }));
    this.owner.model.isNew = false;
  }

  async getToken() {
    let owner = this.owner.model;
    if (owner && !owner.accessTokens.github) {
      const temp = await UserModel.findById(owner._id);
      if (temp) {
        owner = temp;
      }
    }
    if (owner && owner.accessTokens && owner.accessTokens.github) {
      if (owner.accessTokens.github != this._model.source.accessToken) {
        this._model.source.accessToken = owner.accessTokens.github;
      }
      return owner.accessTokens.github;
    }
    if (this._model.source.accessToken) {
      try {
        return this._model.source.accessToken;
      } catch {
        console.debug("[ERROR] Token is invalid", this._model.source.gistId);
      }
    }
    return config.GITHUB_TOKEN;
  }

  async download() {
    console.debug("[INFO] Downloading gist", this._model.source.gistId);
    const oct = octokit(await this.getToken());

    const gist_id = this._model.source.gistId;

    const [gistInfo, comments] = await Promise.all([
      oct.rest.gists.get({ gist_id }),
      oct.paginate("GET /gists/{gist_id}/comments", {
        gist_id,
        per_page: 100,
      }),
    ]);

    const files = Object.values(gistInfo.data.files || {})
      .filter((f): f is NonNullable<typeof f> => !!f)
      .map((f) => ({
        filename: f.filename || "",
        content: f.content || "",
        language: f.language || undefined,
        size: f.size || 0,
        type: f.type || undefined,
      }));

    const commentsMapped = comments.map((comment) => ({
      body: comment.body || "",
      creationDate: new Date(comment.created_at),
      updatedDate: new Date(comment.updated_at),
      author: comment.user?.login || "",
    }));

    // Mongoose treats `gist` as a nested path; assigning a plain object that
    // contains nested arrays (files/comments) on an unsaved doc silently drops
    // those arrays. Cache the populated payload off-model so toJSON can read
    // it directly, and also set it on the model for the persisted path.
    const payload = {
      description: gistInfo.data.description || "",
      isPublic: gistInfo.data.public,
      creationDate: gistInfo.data.created_at
        ? new Date(gistInfo.data.created_at)
        : new Date(),
      updatedDate: gistInfo.data.updated_at
        ? new Date(gistInfo.data.updated_at)
        : new Date(),
      ownerLogin: gistInfo.data.owner?.login,
      files,
      comments: commentsMapped,
    };
    this._gistPayload = payload;
    this._model.set("gist", payload);
    this._model.markModified("gist");
  }

  /**
   * Check the status of the gist
   */
  async check() {
    if (
      this._model.options.expirationMode !== "never" &&
      this.status == "ready" &&
      this._model.options.expirationDate
    ) {
      if (this._model.options.expirationDate <= new Date()) {
        await this.expire();
      }
    }
    if (
      this.status == "expired" ||
      this.status == "expiring" ||
      this.status == "removing" ||
      this.status == "removed"
    ) {
      throw new AnonymousError("gist_expired", {
        object: this,
        httpStatus: 410,
      });
    }
    const fiveMinuteAgo = new Date();
    fiveMinuteAgo.setMinutes(fiveMinuteAgo.getMinutes() - 5);

    if (
      this.status == "preparing" ||
      (this.status == "download" && this._model.statusDate > fiveMinuteAgo)
    ) {
      throw new AnonymousError("gist_not_ready", {
        object: this,
        httpStatus: 503,
      });
    }
  }

  async updateIfNeeded(opt?: { force: boolean }): Promise<void> {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (
      opt?.force ||
      (this._model.options.update && this._model.anonymizeDate < yesterday)
    ) {
      await this.updateStatus(RepositoryStatus.DOWNLOAD);
      await this.download();
      this._model.anonymizeDate = new Date();
      await this.updateStatus(RepositoryStatus.READY);
      await this._model.save();
    }
  }

  async anonymize() {
    if (this.status === RepositoryStatus.READY) return;
    await this.updateStatus(RepositoryStatus.PREPARING);
    await this.updateIfNeeded({ force: true });
    await this.updateStatus(RepositoryStatus.READY);
  }

  async countView() {
    this._model.lastView = new Date();
    this._model.pageView = (this._model.pageView || 0) + 1;
    await this._model.save();
  }

  async updateStatus(status: RepositoryStatus, statusMessage?: string) {
    this._model.status = status;
    this._model.statusDate = new Date();
    this._model.statusMessage = statusMessage;
    await this._model.save();
  }

  async expire() {
    await this.updateStatus(RepositoryStatus.EXPIRING);
    await this.resetSate();
    await this.updateStatus(RepositoryStatus.EXPIRED);
  }

  async remove() {
    await this.updateStatus(RepositoryStatus.REMOVING);
    await this.resetSate();
    await this.updateStatus(RepositoryStatus.REMOVED);
  }

  async resetSate(status?: RepositoryStatus, statusMessage?: string) {
    if (status) this._model.status = status;
    if (statusMessage) this._model.statusMessage = statusMessage;
    this._model.gist.comments = [];
    this._model.gist.description = "";
    this._model.gist.files = [];
    this._model.gist.ownerLogin = "";
    await this._model.save();
  }

  async conference(): Promise<Conference | null> {
    if (!this._model.conference) {
      return null;
    }
    const conference = await ConferenceModel.findOne({
      conferenceID: this._model.conference,
    });
    if (conference) return new Conference(conference);
    return null;
  }

  content() {
    const g = this._gistPayload || this._model.gist;
    const output: Record<string, unknown> = {
      anonymizeDate: this._model.anonymizeDate,
      isPublic: g?.isPublic,
    };
    const anonymizer = new ContentAnonimizer({
      ...this.options,
      repoId: this.gistId,
    });
    if (this.options.title) {
      output.description = anonymizer.anonymize(g?.description || "");
    }
    if (this.options.username) {
      output.ownerLogin = anonymizer.anonymize(g?.ownerLogin || "");
    }
    if (this.options.content) {
      output.files = (g?.files || []).map((f) => ({
        filename: anonymizer.anonymize(f.filename),
        content: anonymizer.anonymize(f.content),
        language: f.language,
        size: f.size,
        type: f.type,
      }));
    }
    if (this.options.comments) {
      output.comments = g?.comments?.map((comment) => {
        const o: Record<string, unknown> = {};
        if (this.options.body) o.body = anonymizer.anonymize(comment.body);
        if (this.options.username)
          o.author = anonymizer.anonymize(comment.author);
        if (this.options.date) {
          o.updatedDate = comment.updatedDate;
          o.creationDate = comment.creationDate;
        }
        return o;
      });
    }
    if (this.options.origin) {
      output.sourceGistId = this._model.source.gistId;
    }
    if (this.options.date) {
      output.updatedDate = g?.updatedDate;
      output.creationDate = g?.creationDate;
    }
    return output;
  }

  /***** Getters ********/

  get gistId() {
    return this._model.gistId;
  }

  get options() {
    return this._model.options;
  }

  get source() {
    return this._model.source;
  }

  get model() {
    return this._model;
  }

  get status() {
    return this._model.status;
  }

  toJSON() {
    const m = this._model;
    const g = this._gistPayload || m.gist;
    // Build the gist payload by hand instead of returning the Mongoose
    // sub-doc directly. The /api/gist/source endpoint returns this for an
    // unsaved model right after download(), and the sub-doc's nested array
    // (files) doesn't always survive res.json on a freshly assigned doc.
    return {
      gistId: m.gistId,
      options: m.options,
      conference: m.conference,
      anonymizeDate: m.anonymizeDate,
      status: m.status,
      isPublic: g?.isPublic,
      statusMessage: m.statusMessage,
      source: { gistId: m.source.gistId },
      gist: g
        ? {
            description: g.description,
            isPublic: g.isPublic,
            creationDate: g.creationDate,
            updatedDate: g.updatedDate,
            ownerLogin: g.ownerLogin,
            files: (g.files || []).map((f) => ({
              filename: f.filename,
              content: f.content,
              language: f.language,
              size: f.size,
              type: f.type,
            })),
            comments: (g.comments || []).map((c) => ({
              body: c.body,
              creationDate: c.creationDate,
              updatedDate: c.updatedDate,
              author: c.author,
            })),
          }
        : undefined,
      lastView: m.lastView,
      pageView: m.pageView,
    };
  }
}
