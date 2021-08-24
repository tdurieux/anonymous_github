import { IConferenceDocument } from "./database/conference/conferences.types";

export default class Conference {
  private _date: IConferenceDocument;
  constructor(data: IConferenceDocument) {
    this._date = data;
  }
}
