import * as path from "path";
import AnonymizedFile from "../AnonymizedFile";
import Repository from "../Repository";
import storage from "../storage";
import { SourceBase } from "../types";
import * as stream from "stream";

export default class Zip implements SourceBase {
  type = "Zip";
  repository: Repository;
  url?: string;

  constructor(data: any, repository: Repository) {
    this.repository = repository;
    this.url = data.url;
  }

  async getFiles() {
    return storage.listFiles(this.repository.originalCachePath);
  }

  async getFileContent(file: AnonymizedFile): Promise<stream.Readable> {
    return storage.read(file.originalCachePath);
  }

  toJSON(): any {
    return {
      type: this.type,
    };
  }
}
