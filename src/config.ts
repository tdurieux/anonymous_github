import { resolve } from "path";
import { randomBytes } from "crypto";

interface Config {
  SESSION_SECRET: string;
  REDIS_PORT: number;
  REDIS_HOSTNAME: string;
  CLIENT_ID: string;
  CLIENT_SECRET: string;
  GITHUB_TOKEN: string;
  DEFAULT_QUOTA: number;
  MAX_FILE_FOLDER: number;
  MAX_FILE_SIZE: number;
  MAX_REPO_SIZE: number;
  AUTO_DOWNLOAD_REPO_SIZE: number;
  FREE_DOWNLOAD_REPO_SIZE: number;
  AUTH_CALLBACK: string;
  /**
   * Allow to download repository and files
   */
  ENABLE_DOWNLOAD: boolean;
  STREAMER_ENTRYPOINT: string | null;
  ANONYMIZATION_MASK: string;
  PORT: number;
  APP_HOSTNAME: string;
  DB_USERNAME: string;
  DB_PASSWORD: string;
  DB_HOSTNAME: string;
  FOLDER: string;
  additionalExtensions: string[];
  S3_BUCKET: string | null;
  S3_CLIENT_ID: string | null;
  S3_CLIENT_SECRET: string | null;
  S3_ENDPOINT: string | null;
  S3_REGION: string | null;
  STORAGE: "filesystem" | "s3";
  TRUST_PROXY: number;
  RATE_LIMIT: number;
}
const config: Config = {
  // Predictable defaults are dangerous: a known SESSION_SECRET lets anyone
  // forge session cookies. Default to empty and resolve below — random in
  // dev, required in production. See the post-env block.
  SESSION_SECRET: "",
  CLIENT_ID: "CLIENT_ID",
  CLIENT_SECRET: "CLIENT_SECRET",
  GITHUB_TOKEN: "",
  DEFAULT_QUOTA: 2 * 1024 * 1024 * 1024 * 8,
  MAX_FILE_FOLDER: 1000,
  MAX_FILE_SIZE: 100 * 1024 * 1024, // in b, 100MB
  MAX_REPO_SIZE: 60000, // in kb, 60MB
  AUTO_DOWNLOAD_REPO_SIZE: 150, // in kb, 150kb
  FREE_DOWNLOAD_REPO_SIZE: 150, // in kb, 150kb
  ENABLE_DOWNLOAD: true,
  AUTH_CALLBACK: "http://localhost:5000/github/auth",
  ANONYMIZATION_MASK: "XXXX",
  PORT: 5000,
  TRUST_PROXY: 1,
  RATE_LIMIT: 350,
  APP_HOSTNAME: "anonymous.4open.science",
  DB_USERNAME: "admin",
  DB_PASSWORD: "password",
  DB_HOSTNAME: "mongodb",
  REDIS_HOSTNAME: "redis",
  REDIS_PORT: 6379,
  FOLDER: resolve(__dirname, "..", "repositories"),
  additionalExtensions: [
    "license",
    "dockerfile",
    "sbt",
    "ipynb",
    "gp",
    "out",
    "sol",
    "in",
    "jsonl",
    "ndjson",
  ],
  STORAGE: "filesystem",
  STREAMER_ENTRYPOINT: null,
  S3_BUCKET: null,
  S3_CLIENT_ID: null,
  S3_CLIENT_SECRET: null,
  S3_ENDPOINT: null,
  S3_REGION: null,
};

for (const conf in process.env) {
  const configRecord = config as unknown as Record<string, unknown>;
  if (configRecord[conf] !== undefined) {
    const currentValue = configRecord[conf];
    const envValue = process.env[conf] as string;
    if (typeof currentValue === "number") {
      const parsed = Number(envValue);
      if (!isNaN(parsed)) {
        configRecord[conf] = parsed;
      }
    } else if (typeof currentValue === "boolean") {
      configRecord[conf] = envValue === "true" || envValue === "1";
    } else {
      configRecord[conf] = envValue;
    }
  }
}

// Harden security-sensitive secrets that still hold an unset/predictable
// value after reading the environment (CWE-798).
const isProduction = process.env.NODE_ENV === "production";

// SESSION_SECRET: a known value allows session forgery. Require it in
// production; in development fall back to a per-process random value so the
// app still boots without shipping a guessable secret.
if (!config.SESSION_SECRET || config.SESSION_SECRET === "SESSION_SECRET") {
  if (isProduction) {
    throw new Error(
      "SESSION_SECRET must be set to a strong random value in production"
    );
  }
  config.SESSION_SECRET = randomBytes(32).toString("hex");
  // eslint-disable-next-line no-console
  console.warn(
    "SESSION_SECRET not set — generated a random development secret. " +
      "Sessions will not persist across restarts. Set SESSION_SECRET in production."
  );
}

// Refuse to start in production with the placeholder OAuth credentials or the
// default database password baked into the image.
if (isProduction) {
  const insecureDefaults: [string, string][] = [
    ["CLIENT_ID", "CLIENT_ID"],
    ["CLIENT_SECRET", "CLIENT_SECRET"],
    ["DB_PASSWORD", "password"],
  ];
  for (const [key, badValue] of insecureDefaults) {
    if ((config as unknown as Record<string, unknown>)[key] === badValue) {
      throw new Error(
        `${key} is using its insecure default value; set it via the environment in production`
      );
    }
  }
}

export default config;
