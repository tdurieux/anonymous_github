import config from "../config";
import FileSystem from "./storage/FileSystem";
import S3Storage from "./storage/S3";
import { StorageBase } from "./types";

const storage = config.STORAGE == "s3" ? new S3Storage() : new FileSystem();

export default storage as StorageBase;
