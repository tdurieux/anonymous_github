import config from "../config";
import FileSystem from "./storage/FileSystem";
import S3Storage from "./storage/S3";

export default (() => {
  return config.STORAGE == "s3" ? new S3Storage() : new FileSystem();
})();
