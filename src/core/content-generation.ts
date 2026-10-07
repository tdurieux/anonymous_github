import { createHash } from "crypto";
export function contentGenerationPrefix(generation: string) {
  return `__content/${createHash("sha256").update(generation).digest("hex")}`;
}
