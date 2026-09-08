import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

export interface EncryptedToken {
  version: number;
  keyId: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

export function createTokenCipher(rawKeys: string, activeKeyId: string) {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawKeys);
  } catch {
    throw new Error("CREDENTIAL_KEYS must be a JSON object of base64 keys");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CREDENTIAL_KEYS must be a JSON object");
  }
  const keys = new Map<string, Buffer>();
  for (const [id, value] of Object.entries(parsed)) {
    if (typeof value !== "string" || !id ||
        Buffer.from(value, "base64").length !== 32 ||
        Buffer.from(value, "base64").toString("base64") !== value) {
      throw new Error("Credential keys must be canonical base64-encoded 32-byte keys");
    }
    keys.set(id, Buffer.from(value, "base64"));
  }
  if (!keys.has(activeKeyId)) throw new Error("CREDENTIAL_ACTIVE_KEY_ID is missing from CREDENTIAL_KEYS");
  const aad = (ownerId: string, provider: string) =>
    Buffer.from(JSON.stringify(["credentials", ownerId, provider, "encryptedToken", 1]));
  return {
    encrypt(token: string, ownerId: string, provider: string): EncryptedToken {
      if (!token) throw new Error("Cannot encrypt an empty credential");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", keys.get(activeKeyId)!, nonce);
      cipher.setAAD(aad(ownerId, provider));
      const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
      return { version: 1, keyId: activeKeyId, nonce: nonce.toString("base64"),
        ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
    },
    decrypt(value: EncryptedToken, ownerId: string, provider: string): string {
      try {
        if (!value || value.version !== 1 || !keys.has(value.keyId)) throw new Error();
        const decode = (s: string) => {
          if (typeof s !== "string" || !s) throw new Error();
          const b = Buffer.from(s, "base64");
          if (b.toString("base64") !== s) throw new Error();
          return b;
        };
        const nonce = decode(value.nonce);
        const tag = decode(value.tag);
        if (nonce.length !== 12 || tag.length !== 16) throw new Error();
        const decipher = createDecipheriv("aes-256-gcm", keys.get(value.keyId)!, nonce, { authTagLength: 16 });
        decipher.setAAD(aad(ownerId, provider));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(decode(value.ciphertext)), decipher.final()]).toString("utf8");
      } catch {
        // Never attach the token, envelope, key, or underlying crypto error.
        throw new Error("Credential decryption failed");
      }
    },
  };
}
