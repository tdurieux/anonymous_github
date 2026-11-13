import { createHash } from "crypto";
import { ExpiringMap } from "./expiring-map";

/** Cache only denials, keyed by the exact credential. Never cache successful access. */
export class InvalidCredentialBackoff {
  private readonly rejected: ExpiringMap<boolean>;
  constructor(now = () => Date.now()) { this.rejected = new ExpiringMap<boolean>(2000, now); }
  async run<T>(token: string, request: () => Promise<T>): Promise<T> {
    const key = createHash("sha256").update(token).digest("hex");
    if (this.rejected.get(key)) throw Object.assign(new Error("token_expired"), { status: 401 });
    try { return await request(); }
    catch (error) {
      if ((error as { status?: number })?.status === 401) this.rejected.set(key, true, 60_000);
      throw error;
    }
  }
}
