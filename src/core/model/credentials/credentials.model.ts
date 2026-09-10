import { model, Schema, Types } from "mongoose";
import { EncryptedToken } from "../../credential-crypto";

export interface ICredential {
  ownerId: Types.ObjectId;
  provider: string;
  encryptedToken: EncryptedToken;
  updatedAt: Date;
  encryptedRefreshToken?: EncryptedToken;
  expiresAt?: Date;
  refreshExpiresAt?: Date;
  refreshLock?: string;
  refreshLockUntil?: Date;
  revision?: string;
  revoked?: boolean;
}
const envelope = new Schema({
  version: { type: Number, required: true, enum: [1] },
  keyId: { type: String, required: true },
  nonce: { type: String, required: true },
  ciphertext: { type: String, required: true },
  tag: { type: String, required: true },
}, { _id: false });
const schema = new Schema<ICredential>({
  ownerId: { type: Schema.Types.ObjectId, required: true, ref: "user" },
  provider: { type: String, required: true, enum: ["github", "github-app-user"] },
  encryptedToken: { type: envelope, required: true, select: false },
  updatedAt: { type: Date, required: true },
  encryptedRefreshToken: { type: envelope, select: false },
  expiresAt: Date,
  refreshExpiresAt: Date,
  refreshLock: { type: String, select: false },
  refreshLockUntil: Date,
  revision: String,
  revoked: Boolean,
}, { collection: "credentials" });
schema.index({ ownerId: 1, provider: 1 }, { unique: true });
export default model<ICredential>("Credential", schema);
