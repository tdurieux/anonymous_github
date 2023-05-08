import { FILE_TYPE, SourceBase, StorageBase, Tree } from "../types";
import config from "../../config";

import * as fs from "fs";
import { Extract } from "unzip-stream";
import { join, basename, dirname } from "path";
import { Response } from "express";
import { Readable, pipeline, Transform } from "stream";
import * as archiver from "archiver";
import { promisify } from "util";
import AnonymizedFile from "../AnonymizedFile";
import { lookup } from "mime-types";

export default class FileSystem implements StorageBase {
  type = "FileSystem";

  constructor() {}

  /** @override */
  async exists(p: string): Promise<FILE_TYPE> {
    try {
      const stat = await fs.promises.stat(join(config.FOLDER, p));
      if (stat.isDirectory()) return FILE_TYPE.FOLDER;
      if (stat.isFile()) return FILE_TYPE.FILE;
    } catch (_) {
      // ignore file not found or not downloaded
    }
    return FILE_TYPE.NOT_FOUND;
  }

  /** @override */
  async send(p: string, res: Response) {
    res.sendFile(join(config.FOLDER, p), { dotfiles: "allow" });
  }

  /** @override */
  async read(p: string): Promise<Readable> {
    return fs.createReadStream(join(config.FOLDER, p));
  }

  async fileInfo(path: string) {
    const info = await fs.promises.stat(join(config.FOLDER, path));
    return {
      size: info.size,
      lastModified: info.mtime,
      contentType: info.isDirectory()
        ? "application/x-directory"
        : (lookup(join(config.FOLDER, path)) as string),
    };
  }

  /** @override */
  async write(
    p: string,
    data: Buffer,
    file?: AnonymizedFile,
    source?: SourceBase
  ): Promise<void> {
    await this.mk(dirname(p));
    return fs.promises.writeFile(join(config.FOLDER, p), data);
  }

  /** @override */
  async rm(dir: string): Promise<void> {
    await fs.promises.rm(join(config.FOLDER, dir), {
      force: true,
      recursive: true,
    });
  }

  /** @override */
  async mk(dir: string): Promise<void> {
    if ((await this.exists(dir)) === FILE_TYPE.NOT_FOUND)
      fs.promises.mkdir(join(config.FOLDER, dir), { recursive: true });
  }

  /** @override */
  async listFiles(
    dir: string,
    opt: {
      root?: string;
      onEntry?: (file: { path: string; size: number }) => void;
    } = {}
  ): Promise<Tree> {
    if (opt.root == null) {
      opt.root = config.FOLDER;
    }
    let files = await fs.promises.readdir(join(opt.root, dir));
    const output: Tree = {};
    for (let file of files) {
      let filePath = join(dir, file);
      try {
        const stats = await fs.promises.stat(join(opt.root, filePath));
        if (file[0] == "$") {
          file = "\\" + file;
        }
        if (stats.isDirectory()) {
          output[file] = await this.listFiles(filePath, opt);
        } else if (stats.isFile()) {
          if (opt.onEntry) {
            opt.onEntry({
              path: filePath,
              size: stats.size,
            });
          }
          output[file] = { size: stats.size, sha: stats.ino.toString() };
        }
      } catch (error) {
        console.error(error);
      }
    }
    return output;
  }

  /** @override */
  async extractZip(
    p: string,
    data: Readable,
    file?: AnonymizedFile,
    source?: SourceBase
  ): Promise<void> {
    const pipe = promisify(pipeline);
    return pipe(
      data,
      Extract({
        path: join(config.FOLDER, p),
        decodeString: (buf) => {
          const name = buf.toString();
          const newName = name.substr(name.indexOf("/") + 1);
          if (newName == "") return "/dev/null";
          return newName;
        },
      })
    );
  }

  /** @override */
  async archive(
    dir: string,
    opt?: {
      format?: "zip" | "tar";
      fileTransformer?: (path: string) => Transform;
    }
  ) {
    const archive = archiver(opt?.format || "zip", {});

    this.listFiles(dir, {
      onEntry: async (file) => {
        let rs = await this.read(file.path);
        if (opt?.fileTransformer) {
          // apply transformation on the stream
          rs = rs.pipe(opt.fileTransformer(file.path));
        }
        const f = file.path.replace(dir, "");
        archive.append(rs, {
          name: basename(f),
          prefix: dirname(f),
        });
      },
    }).then(() => {
      archive.finalize();
    });
    return archive;
  }
}
