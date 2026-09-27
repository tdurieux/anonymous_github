function invalid(): never {
  throw new Error("Invalid review JSON");
}

// JSON.parse checks syntax; this bounded walk additionally rejects duplicate
// decoded keys, including escaped spellings, before typed field validation.
export function decodeReviewJSON(bytes: Buffer): unknown {
  if (bytes.length > 65536) invalid();
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    invalid();
  }
  let at = 0;
  const space = () => {
    while (/\s/.test(text[at] || "") && at < text.length) at++;
  };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      if (text[at] === "\\") {
        at += 2;
        continue;
      }
      if (text[at++] === '"') return JSON.parse(text.slice(start, at));
    }
    return invalid();
  };
  const walk = (depth: number): void => {
    if (depth > 8) invalid();
    space();
    if (text[at] === '"') {
      string();
      return;
    }
    if (text[at] === "{" || text[at] === "[") {
      const isObject = text[at++] === "{",
        end = isObject ? "}" : "]",
        keys = new Set<string>();
      space();
      if (text[at] === end) {
        at++;
        return;
      }
      for (;;) {
        space();
        if (isObject) {
          const key = string();
          if (keys.has(key)) invalid();
          keys.add(key);
          space();
          at++; // colon; syntax already checked
        }
        walk(depth + 1);
        space();
        if (text[at++] === end) return;
      }
    }
    while (at < text.length && !/[\s,}\]]/.test(text[at])) at++;
  };
  walk(0);
  space();
  if (at !== text.length) invalid();
  return parsed;
}
