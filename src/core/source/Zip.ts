import * as stream from "stream";

import AnonymizedFile from "../AnonymizedFile";
import storage from "../storage";
import { SourceBase } from "./Source";

export default class Zip implements SourceBase {
  type = "Zip";
  url?: string;

  constructor(data: any, readonly repoId: string) {
    this.url = data.url;
  }

  async getFiles() {
    return storage.listFiles(this.repoId);
  }

  async getFileContent(file: AnonymizedFile): Promise<stream.Readable> {
    return storage.read(file.repository.repoId, file.filePath);
  }

  toJSON(): any {
    return {
      type: this.type,
    };
  }
}
