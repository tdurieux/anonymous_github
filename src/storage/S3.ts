import { StorageBase, Tree, TreeFile } from "../types";
import { S3 } from "aws-sdk";
import config from "../../config";
import * as stream from "stream";
import { promisify } from "util";
import { ArchiveStreamToS3 } from "archive-stream-to-s3";
import * as express from "express";
import * as mime from "mime-types";
import * as flow from "xml-flow";
import * as archiver from "archiver";
import * as path from "path";
import * as gunzip from "gunzip-maybe";
import AnonymousError from "../AnonymousError";

const originalArchiveStreamToS3Entry: Function = (ArchiveStreamToS3 as any)
  .prototype.onEntry;

export default class S3Storage implements StorageBase {
  type = "AWS";
  client: S3;

  constructor() {
    if (!config.S3_BUCKET) throw new AnonymousError("s3_config_not_provided");
    this.client = new S3({
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      accessKeyId: config.S3_CLIENT_ID,
      secretAccessKey: config.S3_CLIENT_SECRET,
    });
  }

  /** @override */
  async exists(path: string): Promise<boolean> {
    try {
      await this.client
        .headObject({
          Bucket: config.S3_BUCKET,
          Key: path,
        })
        .promise();
      return true;
    } catch (err) {
      return false;
    }
  }

  /** @override */
  async mk(dir: string): Promise<void> {
    if (dir && dir[dir.length - 1] != "/") dir = dir + "/";

    await this.client
      .putObject({
        Bucket: config.S3_BUCKET,
        Key: dir,
      })
      .promise();
  }

  /** @override */
  async rm(dir: string): Promise<void> {
    const data = await this.client
      .listObjectsV2({
        Bucket: config.S3_BUCKET,
        Prefix: dir,
      })
      .promise();

    const params = { Bucket: config.S3_BUCKET, Delete: { Objects: [] } };

    data.Contents.forEach(function (content) {
      params.Delete.Objects.push({ Key: content.Key });
    });

    if (params.Delete.Objects.length == 0) {
      // nothing to remove
      return;
    }
    await this.client.deleteObjects(params).promise();

    if (data.IsTruncated) {
      await this.rm(dir);
    }
  }

  /** @override */
  send(p: string, res: express.Response) {
    const s = this.client
      .getObject({
        Bucket: config.S3_BUCKET,
        Key: p,
      })
      .on("error", (error) => {
        try {
          res.status(error.statusCode);
        } catch (err) {
          console.error(err);
        }
      })
      .on("httpHeaders", (statusCode, headers, response) => {
        res.status(statusCode);
        if (statusCode < 300) {
          res.set("Content-Length", headers["content-length"]);
          res.set("Content-Type", headers["content-type"]);
        }
        stream.pipeline(
          response.httpResponse.createUnbufferedStream() as stream.Readable,
          res
        );
      });

    s.send();
  }

  /** @override */
  read(path: string): stream.Readable {
    return this.client
      .getObject({
        Bucket: config.S3_BUCKET,
        Key: path,
      })
      .createReadStream();
  }

  /** @override */
  async write(path: string, data: Buffer): Promise<void> {
    await this.client
      .putObject({
        Bucket: config.S3_BUCKET,
        Key: path,
        Body: data,
        ContentType: mime.lookup(path).toString(),
      })
      .promise();
    return;
  }

  /** @override */
  async listFiles(dir: string): Promise<Tree> {
    if (dir && dir[dir.length - 1] != "/") dir = dir + "/";
    const out: Tree = {};
    const req = await this.client
      .listObjectsV2({
        Bucket: config.S3_BUCKET,
        Prefix: dir,
      })
      .promise();

    if (!req.Contents) return out;
    for (const f of req.Contents) {
      if (!f.Key) continue;
      f.Key = f.Key.replace(dir, "");
      const paths = f.Key.split("/");
      let current: Tree = out;
      for (let i = 0; i < paths.length - 1; i++) {
        let p = paths[i];
        if (!p) continue;
        if (!(current[p] as Tree)) {
          current[p] = {} as Tree;
        }
        current = current[p] as Tree;
      }

      const fileInfo: TreeFile = { size: f.Size || 0, sha: f.ETag };
      const fileName = paths[paths.length - 1];
      if (fileName) current[fileName] = fileInfo;
    }
    return out;
  }

  /** @override */
  async extractTar(p: string, data: stream.Readable): Promise<void> {
    const pipeline = promisify(stream.pipeline);

    let toS3: ArchiveStreamToS3;

    (ArchiveStreamToS3 as any).prototype.onEntry = function (
      header: any,
      stream: any,
      next: any
    ) {
      header.name = header.name.substr(header.name.indexOf("/") + 1);
      originalArchiveStreamToS3Entry.call(toS3, header, stream, next);
    };

    toS3 = new ArchiveStreamToS3(config.S3_BUCKET, p, this.client);

    return pipeline(data, gunzip(), toS3);
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
    if (dir && dir[dir.length - 1] != "/") dir = dir + "/";
    const req = this.client.listObjectsV2({
      Bucket: config.S3_BUCKET,
      Prefix: dir,
    });
    const filesStream = req.createReadStream();

    const xmlStream = flow(filesStream);

    const that = this;
    xmlStream.on("tag:contents", function (file) {
      let rs = that.read(file.key);
      file.key = file.key.replace(dir, "");
      const filename = path.basename(file.key);
      if (filename == "") return;
      if (opt?.fileTransformer) {
        rs = rs.pipe(opt.fileTransformer(filename));
      }
      archive.append(rs, {
        name: filename,
        prefix: path.dirname(file.key),
      });
    });
    xmlStream.on("end", () => {
      archive.finalize();
    });
    return archive;
  }
}
