import AnonymizedRepositoryModel from "./model/anonymizedRepositories/anonymizedRepositories.model";
import { IConferenceDocument } from "./model/conference/conferences.types";
import Repository from "./Repository";
import { ConferenceStatus } from "./types";

export default class Conference {
  private _data: IConferenceDocument;
  private _repositories: Repository[] = [];

  constructor(data: IConferenceDocument) {
    this._data = data;
  }

  /**
   * Update the status of the conference
   * @param status the new status
   * @param errorMessage a potential error message to display
   */
  async updateStatus(status: ConferenceStatus, errorMessage?: string) {
    this._data.status = status;
    await this._data.save();
    return;
  }

  /**
   * Check if the conference is expired
   */
  isExpired() {
    return this._data.endDate < new Date();
  }

  /**
   * Expire the conference
   */
  async expire() {
    await this.updateStatus("expired");
    await Promise.all(
      (await this.repositories()).map(async (conf) => await conf.expire())
    );
  }

  /**
   * Remove the conference
   */
  async remove() {
    await this.updateStatus("removed");
    await Promise.all(
      (await this.repositories()).map(async (conf) => await conf.remove())
    );
  }

  /**
   * Returns the list of repositories of this conference
   *
   * @returns the list of repositories of this conference
   */
  async repositories(): Promise<Repository[]> {
    if (this._repositories) return this._repositories;
    const repoIds = this._data.repositories
      .filter((r) => !r.removeDate)
      .map((r) => r.id)
      .filter((f) => f);
    this._repositories = (
      await AnonymizedRepositoryModel.find({
        _id: { $in: repoIds },
      })
    ).map((r) => new Repository(r));
    return this._repositories;
  }

  get ownerIDs() {
    return this._data?.owners;
  }

  get quota() {
    return this._data.plan.quota;
  }

  get status() {
    return this._data.status;
  }

  get conferenceID() {
    return this._data.conferenceID;
  }

  get name() {
    return this._data.name;
  }

  get startDate() {
    return this._data.startDate;
  }

  get endDate() {
    return this._data.endDate;
  }

  get url() {
    return this._data.url;
  }

  get options() {
    return this._data.options;
  }

  toJSON(opt?: { billing: boolean }): any {
    const pricePerHourPerRepo = this._data.plan.pricePerRepository / 30;
    let price = 0;
    const today =
      new Date() > this._data.endDate ? this._data.endDate : new Date();
    this._data.repositories.forEach((r) => {
      const removeDate =
        r.removeDate && r.removeDate < today ? r.removeDate : today;
      price +=
        (Math.max(removeDate.getTime() - r.addDate.getTime(), 0) /
          1000 /
          60 /
          60 /
          24) *
        pricePerHourPerRepo;
    });
    return {
      conferenceID: this._data.conferenceID,
      name: this._data.name,
      url: this._data.url,
      startDate: this._data.startDate,
      endDate: this._data.endDate,
      status: this._data.status,
      billing: this._data.billing,
      options: this._data.options,
      plan: this._data.plan,
      price,
      nbRepositories: this._data.repositories.filter((r) => !r.removeDate)
        .length,
    };
  }
}
