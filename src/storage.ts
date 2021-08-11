import FileSystem from "./storage/FileSystem";
import S3Storage from "./storage/S3";
import { StorageBase } from "./types";

const storage = new FileSystem();

export default storage as StorageBase;
