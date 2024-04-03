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

  async getFiles(progress?: (status: string) => void) {
    let nbFiles = 0;
    return storage.listFiles(this.repoId, "", {
      onEntry: () => {
        if (progress) {
          nbFiles++;
          progress("List file: " + nbFiles);
        }
      },
    });
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
