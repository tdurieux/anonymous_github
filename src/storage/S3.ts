import { FILE_TYPE, SourceBase, StorageBase, Tree, TreeFile } from "../types";
import {
  GetObjectCommand,
  ListObjectsV2CommandOutput,
  PutObjectCommandInput,
  S3,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@aws-sdk/node-http-handler";
import config from "../../config";
import { pipeline, Readable, Transform } from "stream";
import ArchiveStreamToS3 from "decompress-stream-to-s3";
import { Response } from "express";
import { lookup } from "mime-types";
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

  private client(timeout = 10000) {
    if (!config.S3_CLIENT_ID) throw new Error("S3_CLIENT_ID not set");
    if (!config.S3_CLIENT_SECRET) throw new Error("S3_CLIENT_SECRET not set");
    return new S3({
      credentials: {
        accessKeyId: config.S3_CLIENT_ID,
        secretAccessKey: config.S3_CLIENT_SECRET,
      },
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      requestHandler: new NodeHttpHandler({
        requestTimeout: timeout,
        connectionTimeout: timeout,
      }),
    });
  }

  /** @override */
  async exists(path: string): Promise<FILE_TYPE> {
    if (!config.S3_BUCKET) throw new Error("S3_BUCKET not set");
    try {
      // if we can get the file info, it is a file
      await this.fileInfo(path);
      return FILE_TYPE.FILE;
    } catch (err) {
      // check if it is a directory
      const data = await this.client().listObjectsV2({
        Bucket: config.S3_BUCKET,
        Prefix: path,
        MaxKeys: 1,
      });
      return (data.Contents?.length || 0) > 0
        ? FILE_TYPE.FOLDER
        : FILE_TYPE.NOT_FOUND;
    }
  }

  /** @override */
  async mk(dir: string): Promise<void> {
    // no need to create folder on S3
  }

  /** @override */
  async rm(dir: string): Promise<void> {
    if (!config.S3_BUCKET) throw new Error("S3_BUCKET not set");
    const data = await this.client(200000).listObjectsV2({
      Bucket: config.S3_BUCKET,
      Prefix: dir,
      MaxKeys: 100,
    });

    const params = {
      Bucket: config.S3_BUCKET,
      Delete: { Objects: new Array<{ Key: string }>() },
    };

    data.Contents?.forEach(function (content) {
      if (content.Key) {
        params.Delete.Objects.push({ Key: content.Key });
      }
    });

    if (params.Delete.Objects.length == 0) {
      // nothing to remove
      return;
    }
    await this.client(200000).deleteObjects(params);

    if (data.IsTruncated) {
      await this.rm(dir);
    }
  }

  /** @override */
  async send(p: string, res: Response) {
    if (!config.S3_BUCKET) throw new Error("S3_BUCKET not set");
    try {
      const command = new GetObjectCommand({
        Bucket: config.S3_BUCKET,
        Key: p,
      });
      const s = await this.client().send(command);
      res.status(200);
      if (s.ContentType) {
        res.contentType(s.ContentType);
      }
      if (s.ContentLength) {
        res.set("Content-Length", s.ContentLength.toString());
      }
      if (s.Body) {
        (s.Body as Readable)?.pipe(res);
      } else {
        res.end();
      }
    } catch (error) {
      try {
        res.status(500);
      } catch (err) {
        console.error(`[ERROR] S3 send ${p}`, err);
      }
    }
  }

  async fileInfo(path: string) {
    if (!config.S3_BUCKET) throw new Error("S3_BUCKET not set");
    const info = await this.client(3000).headObject({
      Bucket: config.S3_BUCKET,
      Key: path,
    });
    return {
      size: info.ContentLength,
      lastModified: info.LastModified,
      contentType: info.ContentType
        ? info.ContentType
        : (lookup(path) as string),
    };
  }

  /** @override */
  async read(path: string): Promise<Readable> {
    if (!config.S3_BUCKET) throw new Error("S3_BUCKET not set");
    const command = new GetObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: path,
    });
    const res = (await this.client(3000).send(command)).Body;
    if (!res) {
      throw new AnonymousError("file_not_found", {
        httpStatus: 404,
        object: path,
      });
    }
    return res as Readable;
  }

  /** @override */
  async write(
    path: string,
    data: Buffer,
    file?: AnonymizedFile,
    source?: SourceBase
  ): Promise<void> {
    if (!config.S3_BUCKET) throw new Error("S3_BUCKET not set");
    const params: PutObjectCommandInput = {
      Bucket: config.S3_BUCKET,
      Key: path,
      Body: data,
      ContentType: lookup(path).toString(),
    };
    if (source) {
      params.Tagging = `source=${source.type}`;
    }
    // 30s timeout
    await this.client(30000).putObject(params);
    return;
  }

  /** @override */
  async listFiles(dir: string): Promise<Tree> {
    if (!config.S3_BUCKET) throw new Error("S3_BUCKET not set");
    if (dir && dir[dir.length - 1] != "/") dir = dir + "/";
    const out: Tree = {};
    let req: ListObjectsV2CommandOutput;
    let nextContinuationToken: string | undefined;
    do {
      req = await this.client(30000).listObjectsV2({
        Bucket: config.S3_BUCKET,
        Prefix: dir,
        MaxKeys: 250,
        ContinuationToken: nextContinuationToken,
      });
      if (!req.Contents) return out;
      nextContinuationToken = req.NextContinuationToken;

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

        if (f.ETag) {
          const fileInfo: TreeFile = { size: f.Size || 0, sha: f.ETag };
          const fileName = paths[paths.length - 1];
          if (fileName) current[fileName] = fileInfo;
        }
      }
    } while (req && req.Contents && req.IsTruncated);
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
      if (!config.S3_BUCKET) return reject("S3_BUCKET not set");
      toS3 = new ArchiveStreamToS3({
        bucket: config.S3_BUCKET,
        prefix: p,
        s3: this.client(2 * 60 * 60 * 1000), // 2h timeout
        type: "zip",
        onEntry: (header) => {
          header.name = header.name.substring(header.name.indexOf("/") + 1);
          if (source) {
            header.Tagging = `source=${source.type}`;
            header.Metadata = {
              source: source.type,
            };
          }
        },
        maxParallel: 10,
      });
      pipeline(data, toS3, (err) => {
        if (err) {
          return reject(err);
        }
        resolve();
      })
        .on("finish", resolve)
        .on("error", reject);
    });
  }

  /** @override */
  async archive(
    dir: string,
    opt?: {
      format?: "zip" | "tar";
      fileTransformer?: (p: string) => Transform;
    }
  ) {
    if (!config.S3_BUCKET) throw new Error("S3_BUCKET not set");
    const archive = archiver(opt?.format || "zip", {});
    if (dir && dir[dir.length - 1] != "/") dir = dir + "/";

    let req: ListObjectsV2CommandOutput;
    let nextContinuationToken: string | undefined;
    do {
      req = await this.client(30000).listObjectsV2({
        Bucket: config.S3_BUCKET,
        Prefix: dir,
        MaxKeys: 250,
        ContinuationToken: nextContinuationToken,
      });

      nextContinuationToken = req.NextContinuationToken;
      for (const f of req.Contents || []) {
        if (!f.Key) continue;
        const filename = basename(f.Key);
        const prefix = dirname(f.Key.replace(dir, ""));

        let rs = await this.read(f.Key);
        if (opt?.fileTransformer) {
          // apply transformation on the stream
          rs = rs.pipe(opt.fileTransformer(f.Key));
        }

        archive.append(rs, {
          name: filename,
          prefix,
        });
      }
    } while (req && req.Contents?.length && req.IsTruncated);
    archive.finalize();
    return archive;
  }
}
