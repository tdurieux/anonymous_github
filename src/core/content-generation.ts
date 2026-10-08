import { createHash } from "crypto";
export function contentGenerationPrefix(generation: string) {
  return `__content/${createHash("sha256").update(generation).digest("hex")}`;
}

export function contentRetirementMarker(prefix: string) {
  if (!/^__content\/[a-f0-9]{64}$/.test(prefix)) throw new Error("Invalid content generation prefix");
  return `__content/__retired/${prefix.slice("__content/".length)}.txt`;
}
