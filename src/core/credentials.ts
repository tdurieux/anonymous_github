import { Types } from "mongoose";
import config from "../config";
import { createTokenCipher } from "./credential-crypto";
import CredentialModel from "./model/credentials/credentials.model";
import UserModel from "./model/users/users.model";

export function credentialCipher() {
  return createTokenCipher(config.CREDENTIAL_KEYS, config.CREDENTIAL_ACTIVE_KEY_ID);
}

export async function getCredential(ownerId: string, provider = "github") {
  const credential = await CredentialModel.findOne({ ownerId, provider }).select("+encryptedToken").lean();
  if (credential) {
    return { token: credentialCipher().decrypt(credential.encryptedToken, String(credential.ownerId), provider),
      updatedAt: credential.updatedAt, persisted: true };
  }
  if (config.CREDENTIAL_LEGACY_READS && provider === "github") {
    const user = await UserModel.findById(ownerId).select("+accessTokens.github accessTokenDates");
    const token = user?.accessTokens?.github;
    if (token) return { token, updatedAt: user?.accessTokenDates?.github, persisted: false };
  }
  return null;
}

export async function getCredentialToken(ownerId: string, provider = "github", resource?: {
  collection: "anonymizedrepositories" | "anonymizedgists" | "anonymizedpullrequests";
  id: unknown;
}): Promise<string> {
  const credential = await getCredential(ownerId, provider);
  if (credential) return credential.token;
  if (config.CREDENTIAL_LEGACY_READS && provider === "github" && resource) {
    const row = await CredentialModel.db.collection(resource.collection).findOne({
      _id: resource.id as Types.ObjectId,
      owner: new Types.ObjectId(ownerId),
    }, { projection: { "source.accessToken": 1 } });
    if (typeof row?.source?.accessToken === "string") return row.source.accessToken;
  }
  return "";
}

export async function setCredential(ownerId: string, token: string, provider = "github") {
  ownerId = new Types.ObjectId(ownerId).toHexString();
  const encryptedToken = credentialCipher().encrypt(token, ownerId, provider);
  await CredentialModel.updateOne({ ownerId, provider }, {
    $set: { encryptedToken, updatedAt: new Date() },
  }, { upsert: true, runValidators: true });
}

// A refresh must not overwrite a credential replaced by a concurrent login.
export async function replaceCredential(ownerId: string, previous: string, token: string) {
  const current = await CredentialModel.findOne({ ownerId, provider: "github" }).select("+encryptedToken").lean();
  if (!current) {
    // Legacy credentials are migrated by the migration script or next login.
    return false;
  }
  const cipher = credentialCipher();
  if (cipher.decrypt(current.encryptedToken, String(ownerId), "github") !== previous) return false;
  const result = await CredentialModel.updateOne({ _id: current._id, encryptedToken: current.encryptedToken }, {
    $set: { encryptedToken: cipher.encrypt(token, String(ownerId), "github"), updatedAt: new Date() },
  });
  return result.modifiedCount === 1;
}
