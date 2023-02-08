import { SourceBase, StorageBase, Tree, TreeFile } from "../types";
import { S3 } from "aws-sdk";
import config from "../../config";
import { pipeline, Readable } from "stream";
import ArchiveStreamToS3 from "decompress-stream-to-s3";
import { Response } from "express";
import { lookup } from "mime-types";
import * as flow from "xml-flow";
import * as archiver from "archiver";
import { dirname, basename } from "path";
import AnonymousError from "../AnonymousError";
import AnonymizedFile from "../AnonymizedFile";

export default class S3Storage implements StorageBase {
  type = "AWS";

  constructor() {
    if (!config.S3_BUCKET)
      throw new AnonymousError("s3_config_not_provided", {
        httpStatus: 500,
      });
  }

  get client() {
    return new S3({
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      accessKeyId: config.S3_CLIENT_ID,
      secretAccessKey: config.S3_CLIENT_SECRET,
      httpOptions: {
        timeout: 1000 * 60 * 60 * 2, // 2 hour
      },
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
  send(p: string, res: Response) {
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
        (response.httpResponse.createUnbufferedStream() as Readable).pipe(res);
      });

    s.send();
  }

  /** @override */
  read(path: string): Readable {
    return this.client
      .getObject({
        Bucket: config.S3_BUCKET,
        Key: path,
      })
      .createReadStream();
  }

  /** @override */
  async write(
    path: string,
    data: Buffer,
    file?: AnonymizedFile,
    source?: SourceBase
  ): Promise<void> {
    const params: S3.PutObjectRequest = {
      Bucket: config.S3_BUCKET,
      Key: path,
      Body: data,
      ContentType: lookup(path).toString(),
    };
    if (source) {
      params.Tagging = `source=${source.type}`;
    }
    await this.client.putObject(params).promise();
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
  async extractZip(
    p: string,
    data: Readable,
    file?: AnonymizedFile,
    source?: SourceBase
  ): Promise<void> {
    let toS3: ArchiveStreamToS3;

    return new Promise((resolve, reject) => {
      toS3 = new ArchiveStreamToS3({
        bucket: config.S3_BUCKET,
        prefix: p,
        s3: this.client,
        type: "zip",
        onEntry: (header) => {
          header.name = header.name.substr(header.name.indexOf("/") + 1);
          if (source) {
            header.Tagging = `source=${source.type}`;
          }
        },
      });
      pipeline(data, toS3, () => {})
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
      const filename = basename(file.key);
      if (filename == "") return;
      if (opt?.fileTransformer) {
        rs = rs.pipe(opt.fileTransformer(filename));
      }
      archive.append(rs, {
        name: filename,
        prefix: dirname(file.key),
      });
    });
    xmlStream.on("end", () => {
      archive.finalize();
    });
    return archive;
  }
}
