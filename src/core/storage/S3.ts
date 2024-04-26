import {
  GetObjectCommand,
  ListObjectsV2CommandOutput,
  PutObjectCommandInput,
  S3,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import config from "../../config";
import { pipeline, Readable, Transform } from "stream";
import ArchiveStreamToS3 from "decompress-stream-to-s3";
import { Response } from "express";
import { lookup } from "mime-types";
import * as archiver from "archiver";
import { trace } from "@opentelemetry/api";
import { dirname, basename, join } from "path";
import AnonymousError from "../AnonymousError";
import StorageBase, { FILE_TYPE } from "./Storage";
import { IFile } from "../model/files/files.types";
import FileModel from "../model/files/files.model";

export default class S3Storage extends StorageBase {
  type = "AWS";

  constructor() {
    super();
    if (!config.S3_BUCKET)
      throw new AnonymousError("s3_config_not_provided", {
        httpStatus: 500,
      });
  }

  private client(timeout = 10000) {
    if (!config.S3_CLIENT_ID) throw new Error("S3_CLIENT_ID not set");
    if (!config.S3_CLIENT_SECRET) throw new Error("S3_CLIENT_SECRET not set");
    if (!config.S3_REGION) throw new Error("S3_REGION not set");
    if (!config.S3_ENDPOINT) throw new Error("S3_ENDPOINT not set");
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
  async exists(repoId: string, path: string = ""): Promise<FILE_TYPE> {
    const span = trace.getTracer("ano-file").startSpan("s3.exists");
    span.setAttribute("path", path);
    try {
      if (!config.S3_BUCKET) throw new Error("S3_BUCKET not set");
      try {
        // if we can get the file info, it is a file
        await this.fileInfo(repoId, path);
        return FILE_TYPE.FILE;
      } catch (err) {
        // check if it is a directory
        const data = await this.client().listObjectsV2({
          Bucket: config.S3_BUCKET,
          Prefix: join(this.repoPath(repoId), path),
          MaxKeys: 1,
        });
        return (data.Contents?.length || 0) > 0
          ? FILE_TYPE.FOLDER
          : FILE_TYPE.NOT_FOUND;
      }
    } finally {
      span.end();
    }
  }

  /** @override */
  async mk(repoId: string, dir: string = ""): Promise<void> {
    // no need to create folder on S3
  }

  /** @override */
  async rm(repoId: string, dir: string = ""): Promise<void> {
    const span = trace.getTracer("ano-file").startSpan("s3.rm");
    span.setAttribute("repoId", repoId);
    span.setAttribute("path", dir);
    try {
      if (!config.S3_BUCKET) throw new Error("S3_BUCKET not set");
      const data = await this.client(200000).listObjectsV2({
        Bucket: config.S3_BUCKET,
        Prefix: join(this.repoPath(repoId), dir),
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
        await this.rm(repoId, dir);
      }
    } finally {
      span.end();
    }
  }

  /** @override */
  async send(repoId: string, path: string, res: Response) {
    const span = trace.getTracer("ano-file").startSpan("s3.send");
    span.setAttribute("repoId", repoId);
    span.setAttribute("path", path);
    try {
      if (!config.S3_BUCKET) throw new Error("S3_BUCKET not set");
      try {
        const command = new GetObjectCommand({
          Bucket: config.S3_BUCKET,
          Key: join(this.repoPath(repoId), path),
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
        span.recordException(error as Error);
        try {
          res.status(500);
        } catch (err) {
          console.error(`[ERROR] S3 send ${path}`, err);
        }
      }
    } finally {
      span.end();
    }
  }

  async fileInfo(repoId: string, path: string) {
    const span = trace.getTracer("ano-file").startSpan("s3.fileInfo");
    span.setAttribute("repoId", repoId);
    span.setAttribute("path", path);
    try {
      if (!config.S3_BUCKET) throw new Error("S3_BUCKET not set");
      const info = await this.client(3000).headObject({
        Bucket: config.S3_BUCKET,
        Key: join(this.repoPath(repoId), path),
      });
      return {
        size: info.ContentLength,
        lastModified: info.LastModified,
        contentType: info.ContentType
          ? info.ContentType
          : (lookup(path) as string),
      };
    } finally {
      span.end();
    }
  }

  /** @override */
  async read(repoId: string, path: string): Promise<Readable> {
    const span = trace.getTracer("ano-file").startSpan("s3.rreadm");
    span.setAttribute("repoId", repoId);
    span.setAttribute("path", path);
    try {
      if (!config.S3_BUCKET) throw new Error("S3_BUCKET not set");
      const command = new GetObjectCommand({
        Bucket: config.S3_BUCKET,
        Key: join(this.repoPath(repoId), path),
      });
      const res = (await this.client(3000).send(command)).Body;
      if (!res) {
        throw new AnonymousError("file_not_found", {
          httpStatus: 404,
          object: join(this.repoPath(repoId), path),
        });
      }
      return res as Readable;
    } finally {
      span.end();
    }
  }

  /** @override */
  async write(
    repoId: string,
    path: string,
    data: string | Readable,
    source?: string
  ): Promise<void> {
    const span = trace.getTracer("ano-file").startSpan("s3.rm");
    span.setAttribute("repoId", repoId);
    span.setAttribute("path", path);
    try {
      if (!config.S3_BUCKET) throw new Error("S3_BUCKET not set");

      if (data instanceof Readable) {
        data.on("error", (err) => {
          console.error(`[ERROR] S3 write ${path}`, err);
          span.recordException(err as Error);
          this.rm(repoId, path);
        });
      }

      const params: PutObjectCommandInput = {
        Bucket: config.S3_BUCKET,
        Key: join(this.repoPath(repoId), path),
        Body: data,
        ContentType: lookup(path).toString(),
      };
      if (source) {
        params.Tagging = `source=${source}`;
      }

      const parallelUploads3 = new Upload({
        // 30s timeout
        client: this.client(30000),
        params,
      });

      await parallelUploads3.done();
    } finally {
      span.end();
    }
  }

  /** @override */
  async listFiles(repoId: string, dir: string = ""): Promise<IFile[]> {
    const span = trace.getTracer("ano-file").startSpan("s3.listFiles");
    span.setAttribute("path", dir);
    try {
      if (!config.S3_BUCKET) throw new Error("S3_BUCKET not set");
      if (dir && dir[dir.length - 1] != "/") dir = dir + "/";
      const out: IFile[] = [];
      let req: ListObjectsV2CommandOutput;
      let nextContinuationToken: string | undefined;
      do {
        req = await this.client(30000).listObjectsV2({
          Bucket: config.S3_BUCKET,
          Prefix: join(this.repoPath(repoId), dir),
          MaxKeys: 250,
          ContinuationToken: nextContinuationToken,
        });
        if (!req.Contents) return out;
        nextContinuationToken = req.NextContinuationToken;

        for (const f of req.Contents) {
          if (!f.Key) continue;
          f.Key = f.Key.replace(join(this.repoPath(repoId), dir), "");
          out.push(
            new FileModel({
              name: basename(f.Key),
              path: dirname(f.Key),
              repoId,
              size: f.Size,
              sha: f.ETag,
            })
          );
        }
      } while (req && req.Contents && req.IsTruncated);
      return out;
    } finally {
      span.end();
    }
  }

  /** @override */
  async extractZip(
    repoId: string,
    path: string,
    data: Readable,
    source?: string
  ): Promise<void> {
    let toS3: ArchiveStreamToS3;
    const span = trace.getTracer("ano-file").startSpan("s3.extractZip");
    span.setAttribute("path", path);
    return new Promise((resolve, reject) => {
      if (!config.S3_BUCKET) return reject("S3_BUCKET not set");
      toS3 = new ArchiveStreamToS3({
        bucket: config.S3_BUCKET,
        prefix: join(this.repoPath(repoId), path),
        s3: this.client(2 * 60 * 60 * 1000), // 2h timeout
        type: "zip",
        onEntry: (header) => {
          header.name = header.name.substring(header.name.indexOf("/") + 1);
          if (source) {
            header.Tagging = `source=${source}`;
            header.Metadata = {
              source: source,
            };
          }
        },
        maxParallel: 10,
      });
      pipeline(data, toS3, (err) => {
        if (err) {
          span.recordException(err as Error);
          return reject(err);
        }
        span.end();
        resolve();
      })
        .on("finish", () => {
          span.end();
          resolve();
        })
        .on("error", reject);
    });
  }

  /** @override */
  async archive(
    repoId: string,
    dir: string = "",
    opt?: {
      format?: "zip" | "tar";
      fileTransformer?: (p: string) => Transform;
    }
  ) {
    const span = trace.getTracer("ano-file").startSpan("s3.archive");
    span.setAttribute("repoId", repoId);
    span.setAttribute("path", dir);
    try {
      if (!config.S3_BUCKET) throw new Error("S3_BUCKET not set");
      const archive = archiver(opt?.format || "zip", {});
      if (dir && dir[dir.length - 1] != "/") dir = dir + "/";

      let req: ListObjectsV2CommandOutput;
      let nextContinuationToken: string | undefined;
      do {
        req = await this.client(30000).listObjectsV2({
          Bucket: config.S3_BUCKET,
          Prefix: join(this.repoPath(repoId), dir),
          MaxKeys: 250,
          ContinuationToken: nextContinuationToken,
        });

        nextContinuationToken = req.NextContinuationToken;
        for (const f of req.Contents || []) {
          if (!f.Key) continue;
          const filename = basename(f.Key);
          const prefix = dirname(
            f.Key.replace(join(this.repoPath(repoId), dir), "")
          );

          let rs = await this.read(repoId, f.Key);
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
    } finally {
      span.end();
    }
  }
}
