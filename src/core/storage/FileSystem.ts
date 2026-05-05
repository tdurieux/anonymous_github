import config from "../../config";
import * as fs from "fs";
import { Extract } from "unzip-stream";
import { join, basename, dirname } from "path";
import { Response } from "express";
import { Readable, pipeline, Transform } from "stream";
import * as archiver from "archiver";
import { promisify } from "util";
import { lookup } from "mime-types";
import StorageBase, { FILE_TYPE } from "./Storage";
import FileModel from "../model/files/files.model";
import { IFile } from "../model/files/files.types";

export default class FileSystem extends StorageBase {
  type = "FileSystem";

  constructor() {
    super();
  }

  /** @override */
  async exists(repoId: string, p: string = ""): Promise<FILE_TYPE> {
    const fullPath = join(config.FOLDER, this.repoPath(repoId), p);
    try {
      const stat = await fs.promises.stat(fullPath);
      if (stat.isDirectory()) return FILE_TYPE.FOLDER;
      if (stat.isFile()) return FILE_TYPE.FILE;
    } catch {
      // ignore file not found or not downloaded
    }
    return FILE_TYPE.NOT_FOUND;
  }

  /** @override */
  async send(repoId: string, p: string, res: Response) {
    const fullPath = join(config.FOLDER, this.repoPath(repoId), p);
    res.sendFile(fullPath, { dotfiles: "allow" });
  }

  /** @override */
  async read(repoId: string, p: string): Promise<Readable> {
    const fullPath = join(config.FOLDER, this.repoPath(repoId), p);
    return fs.createReadStream(fullPath);
  }

  async fileInfo(repoId: string, path: string) {
    const fullPath = join(config.FOLDER, this.repoPath(repoId), path);
    const info = await fs.promises.stat(fullPath);
    return {
      size: info.size,
      lastModified: info.mtime,
      contentType: info.isDirectory()
        ? "application/x-directory"
        : (lookup(fullPath) as string),
    };
  }

  /** @override */
  async write(
    repoId: string,
    p: string,
    data: string | Readable
  ): Promise<void> {
    const fullPath = join(config.FOLDER, this.repoPath(repoId), p);
    // Atomic write: stream into a sibling .tmp and only rename into place
    // when the source stream finishes successfully. If the source errors
    // mid-flight (transient GitHub 5xx, socket reset, etc.), we drop the
    // tmp and leave any pre-existing cached file untouched. Without this,
    // a partial fetch would commit a 0-byte or truncated cache entry that
    // future reads would happily serve as the file's content.
    await this.mk(repoId, dirname(p));
    const tmpPath = `${fullPath}.tmp.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    try {
      if (typeof data === "string") {
        await fs.promises.writeFile(tmpPath, data);
      } else {
        await new Promise<void>((resolve, reject) => {
          const ws = fs.createWriteStream(tmpPath);
          let settled = false;
          const finish = (err?: Error) => {
            if (settled) return;
            settled = true;
            if (err) {
              ws.destroy();
              reject(err);
            } else {
              resolve();
            }
          };
          data.on("error", finish);
          ws.on("error", finish);
          ws.on("finish", () => finish());
          data.pipe(ws);
        });
      }
      await fs.promises.rename(tmpPath, fullPath);
    } catch (err) {
      console.error("[ERROR] FileSystem.write failed:", err);
      await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  /** @override */
  async rm(repoId: string, dir: string = ""): Promise<void> {
    const fullPath = join(config.FOLDER, this.repoPath(repoId), dir);
    await fs.promises.rm(fullPath, {
      force: true,
      recursive: true,
    });
  }

  /** @override */
  async mk(repoId: string, dir: string = ""): Promise<void> {
    const fullPath = join(config.FOLDER, this.repoPath(repoId), dir);
    try {
      await fs.promises.mkdir(fullPath, {
        recursive: true,
      });
    } catch (err: unknown) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }
  }

  /** @override */
  async listFiles(
    repoId: string,
    dir: string = "",
    opt: {
      onEntry?: (file: { path: string; size: number }) => void;
    } = {}
  ): Promise<IFile[]> {
    const fullPath = join(config.FOLDER, this.repoPath(repoId), dir);
    const files = await fs.promises.readdir(fullPath);
    const output2: IFile[] = [];
    for (const file of files) {
      const filePath = join(fullPath, file);
      try {
        const stats = await fs.promises.stat(filePath);
        if (stats.isDirectory()) {
          output2.push(new FileModel({ name: file, path: dir, repoId }));
          output2.push(
            ...(await this.listFiles(repoId, join(dir, file), opt))
          );
        } else if (stats.isFile()) {
          if (opt.onEntry) {
            opt.onEntry({
              path: join(dir, file),
              size: stats.size,
            });
          }
          // Don't synthesise a sha here. The previous value (stats.ino)
          // wasn't a content hash — just an inode number — and any code
          // that compared it to an upstream Git blob sha would silently
          // disagree. Leave it undefined so callers either look up the
          // real sha from FileModel/GitHub or skip sha-keyed paths.
          output2.push(
            new FileModel({
              name: file,
              path: dir,
              repoId: repoId,
              size: stats.size,
            })
          );
        }
      } catch {
        // ignore stat errors for individual files
      }
    }
    return output2;
  }

  /** @override */
  async extractZip(repoId: string, p: string, data: Readable): Promise<void> {
    const pipe = promisify(pipeline);
    const fullPath = join(config.FOLDER, this.repoPath(repoId), p);
    const extractor = Extract({
      path: fullPath,
      decodeString: (buf) => {
        const name = buf.toString();
        const newName = name.substr(name.indexOf("/") + 1);
        if (newName == "") {
          return "___IGNORE___";
        }
        return newName;
      },
    });
    await pipe(data, extractor);
    await this.rm(repoId, join(p, "___IGNORE___"));
  }

  /** @override */
  async archive(
    repoId: string,
    dir: string,
    opt?: {
      format?: "zip" | "tar";
      fileTransformer?: (path: string) => Transform;
    }
  ) {
    const archive = archiver(opt?.format || "zip", {});
    const fullPath = join(config.FOLDER, this.repoPath(repoId), dir);

    await this.listFiles(repoId, dir, {
      onEntry: async (file) => {
        let rs = await this.read(repoId, file.path);
        if (opt?.fileTransformer) {
          // apply transformation on the stream
          rs = rs.pipe(opt.fileTransformer(file.path));
        }
        const f = file.path.replace(fullPath, "");
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
