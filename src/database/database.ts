import mongoose, { ConnectOptions } from "mongoose";
import Repository from "../Repository";
import config from "../../config";
import AnonymizedRepositoryModel from "./anonymizedRepositories/anonymizedRepositories.model";
import AnonymousError from "../AnonymousError";

const MONGO_URL = `mongodb://${config.DB_USERNAME}:${config.DB_PASSWORD}@${config.DB_HOSTNAME}:27017/`;

export const database = mongoose.connection;

export async function connect() {
  await mongoose.connect(MONGO_URL + "production", {
    authSource: "admin",
  } as ConnectOptions);

  return database;
}

export async function getRepository(repoId: string) {
  const data = await AnonymizedRepositoryModel.findOne({ repoId });
  if (!data)
    throw new AnonymousError("repo_not_found", {
      object: repoId,
      httpStatus: 400,
    });
  return new Repository(data);
}
