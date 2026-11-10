import { createHash } from "crypto";

type ValidationRequest = (etag?: string) => Promise<{ headers: { etag?: string } }>;

/** Store validators, never cached authorization decisions. Every completed
 * check requires a fresh authenticated response from GitHub. */
export class CredentialValidation {
  private readonly validators = new Map<string, string>();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(private readonly capacity = 2000) {}

  check(token: string, request: ValidationRequest): Promise<void> {
    // Quota keys can be shared by multiple credentials. Validation cannot.
    const key = createHash("sha256").update(token).digest("hex");
    const pending = this.pending.get(key);
    if (pending) return pending;
    const check = this.validate(key, request);
    if (this.pending.size >= this.capacity) return check;
    const tracked = check.finally(() => { this.pending.delete(key); });
    this.pending.set(key, tracked);
    return tracked;
  }

  private async validate(key: string, request: ValidationRequest): Promise<void> {
    const etag = this.validators.get(key);
    try {
      const response = await request(etag);
      this.validators.delete(key);
      if (response.headers.etag && this.capacity > 0) {
        if (this.validators.size >= this.capacity) {
          this.validators.delete(this.validators.keys().next().value!);
        }
        this.validators.set(key, response.headers.etag);
      }
    } catch (error) {
      // Octokit throws for 304. Accept it only when this exact credential
      // previously succeeded and this request sent its validator.
      if (etag && (error as { status?: number })?.status === 304) return;
      this.validators.delete(key);
      throw error;
    }
  }
}
