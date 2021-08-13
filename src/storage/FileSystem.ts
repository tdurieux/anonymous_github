import { StorageBase, Tree } from "../types";
import * as fs from "fs";
import * as tar from "tar-fs";
import * as path from "path";
import * as express from "express";
import config from "../../config";
import * as stream from "stream";
import * as gunzip from "gunzip-maybe";
import * as archiver from "archiver";

export default class FileSystem implements StorageBase {
  type = "FileSystem";

  constructor() {}

  /** @override */
  async exists(p: string): Promise<boolean> {
    return fs.existsSync(path.join(config.FOLDER, p));
  }

  /** @override */
  send(p: string, res: express.Response) {
    res.sendFile(path.join(config.FOLDER, p), { dotfiles: "allow" });
  }

  /** @override */
  read(p: string): stream.Readable {
    return fs.createReadStream(path.join(config.FOLDER, p));
  }

  /** @override */
  async write(p: string, data: Buffer): Promise<void> {
    if (!(await this.exists(path.dirname(p)))) {
      await fs.promises.mkdir(path.dirname(path.join(config.FOLDER, p)), {
        recursive: true,
      });
    }
    return fs.promises.writeFile(path.join(config.FOLDER, p), data);
  }

  /** @override */
  async rm(dir: string): Promise<void> {
    await fs.promises.rm(path.join(config.FOLDER, dir), {
      force: true,
      recursive: true,
    });
  }

  /** @override */
  async mk(dir: string): Promise<void> {
    if (!(await this.exists(dir)))
      fs.promises.mkdir(path.join(config.FOLDER, dir), { recursive: true });
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
    let files = await fs.promises.readdir(path.join(opt.root, dir));
    const output: Tree = {};
    for (let file of files) {
      let filePath = path.join(dir, file);
      try {
        const stats = await fs.promises.stat(path.join(opt.root, filePath));
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
  async extractTar(p: string, data: stream.Readable): Promise<void> {
    return new Promise((resolve, reject) => {
      data
        .pipe(gunzip())
        .pipe(
          tar.extract(path.join(config.FOLDER, p), {
            map: (header) => {
              header.name = header.name.substr(header.name.indexOf("/") + 1);
              return header;
            },
          })
        )
        .on("finish", resolve)
        .on("error", reject);
    });
  }

  /** @override */
  archive(
    dir: string,
    opt?: {
      format?: "zip" | "tar";
      fileTransformer?;
    }
  ) {
    const archive = archiver(opt?.format, {});

    this.listFiles(dir, {
      onEntry: (file) => {
        let rs = this.read(file.path);
        if (opt?.fileTransformer) {
          // apply transformation on the stream
          rs = rs.pipe(opt.fileTransformer(file.path));
        }
        const f = file.path.replace(dir, "");
        archive.append(rs, {
          name: path.basename(f),
          prefix: path.dirname(f),
        });
      },
    }).then(() => {
      archive.finalize();
    });
    return archive;
  }
}
