import { resolve } from "path";

interface Config {
  REDIS_PORT: number;
  REDIS_HOSTNAME: string;
  CLIENT_ID: string;
  CLIENT_SECRET: string;
  GITHUB_TOKEN: string;
  DEFAULT_QUOTA: number;
  MAX_FILE_SIZE: number;
  MAX_REPO_SIZE: number;
  AUTO_DOWNLOAD_REPO_SIZE: number;
  FREE_DOWNLOAD_REPO_SIZE: number;
  AUTH_CALLBACK: string;
  /**
   * Allow to download repository and files
   */
  ENABLE_DOWNLOAD: boolean;
  ANONYMIZATION_MASK: string;
  PORT: number;
  HOSTNAME: string;
  DB_USERNAME: string;
  DB_PASSWORD: string;
  DB_HOSTNAME: string;
  FOLDER: string;
  additionalExtensions: string[];
  S3_BUCKET?: string;
  S3_CLIENT_ID?: string;
  S3_CLIENT_SECRET?: string;
  S3_ENDPOINT?: string;
  S3_REGION?: string;
  STORAGE: "filesystem" | "s3";
  TRUST_PROXY: number;
  RATE_LIMIT: number;
}
const config: Config = {
  CLIENT_ID: "CLIENT_ID",
  CLIENT_SECRET: "CLIENT_SECRET",
  GITHUB_TOKEN: "",
  DEFAULT_QUOTA: 2 * 1024 * 1024 * 1024 * 8,
  MAX_FILE_SIZE: 100 * 1024 * 1024, // in b, 10MB
  MAX_REPO_SIZE: 60000, // in kb, 60MB
  AUTO_DOWNLOAD_REPO_SIZE: 150, // in kb, 150kb
  FREE_DOWNLOAD_REPO_SIZE: 150, // in kb, 150kb
  ENABLE_DOWNLOAD: true,
  AUTH_CALLBACK: "http://localhost:5000/github/auth",
  ANONYMIZATION_MASK: "XXXX",
  PORT: 5000,
  TRUST_PROXY: 1,
  RATE_LIMIT: 350,
  HOSTNAME: "anonymous.4open.science",
  DB_USERNAME: "admin",
  DB_PASSWORD: "password",
  DB_HOSTNAME: "mongodb",
  REDIS_HOSTNAME: "redis",
  REDIS_PORT: 6379,
  FOLDER: resolve(__dirname, "repositories"),
  additionalExtensions: [
    "license",
    "dockerfile",
    "sbt",
    "ipynb",
    "gp",
    "out",
    "sol",
    "in",
  ],
  STORAGE: "filesystem",
  S3_BUCKET: null,
  S3_CLIENT_ID: null,
  S3_CLIENT_SECRET: null,
  S3_ENDPOINT: null,
  S3_REGION: null,
};

for (let conf in process.env) {
  if ((config as any)[conf] !== undefined) {
    (config as any)[conf] = process.env[conf];
  }
}

export default config;
