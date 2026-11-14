import { resolve, relative, sep } from "path";
import { LOG_ERROR_TYPES, LOG_SOURCE_FUNCTIONS } from "./log-diagnostic-schema";

// Node 24 exposes Error.stack through a shared native accessor; never call user getters.
const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), "stack")?.get;
const root = resolve(__dirname, "..");
function data(value: unknown, key: string, inherited = false): unknown {
  try {
    let object = value;
    for (let depth = 0; object && typeof object === "object" && depth < (inherited ? 4 : 1); depth++) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor) {
        if ("value" in descriptor) return descriptor.value;
        if (key === "stack" && nativeStackGetter && descriptor.get === nativeStackGetter) return nativeStackGetter.call(object);
        return undefined;
      }
      object = Object.getPrototypeOf(object);
    }
  } catch { /* Logging must not invoke hostile getters or fail with a Proxy. */ }
}
function frame(file: string, fn: string, line: string, column: string): string | null {
  if (!LOG_SOURCE_FUNCTIONS[file]?.includes(fn) || !/^[1-9]\d{0,5}$/.test(line) || !/^[1-9]\d{0,4}$/.test(column)) return null;
  return `at ${fn} (${file}:${line}:${column})`;
}
/** Validate already-projected diagnostics again at every storage/API boundary. */
export function safeDiagnosticFields(value: unknown): Record<string, string> {
  const out: Record<string,string> = {};
  for (const key of ["errorType", "causeType"]) {
    const type = data(value,key);
    if (typeof type === "string" && LOG_ERROR_TYPES.includes(type)) out[key] = type;
  }
  for (const key of ["errorStack", "causeStack"]) {
    const stack = data(value,key);
    if (typeof stack !== "string" || stack.length > 1024) continue;
    const frames = stack.split("\n").slice(0,8).flatMap(line => {
      const match = /^at ([A-Za-z_$][A-Za-z0-9_$]*|<anonymous>) \(((?:src|build)\/[A-Za-z0-9_/-]+\.(?:ts|js)):([1-9]\d{0,5}):([1-9]\d{0,4})\)$/.exec(line);
      const safe = match && frame(match[2],match[1],match[3],match[4]);
      return safe ? [safe] : [];
    });
    if (frames.length) out[key] = frames.join("\n");
  }
  return out;
}
/** Discard exception messages, absolute roots, external frames and unknown function names. */
export function errorDiagnostics(error: unknown): Record<string,string> {
  if (!error || typeof error !== "object") return {};
  const out: Record<string,string> = {};
  const seen = new Set<unknown>();
  let current: unknown = error;
  for(let depth=0; current && typeof current === "object" && depth<3 && !seen.has(current); depth++) {
    seen.add(current);
    const name = data(current,"name",true);
    const type = typeof name === "string" && LOG_ERROR_TYPES.includes(name) ? name : "UnknownError";
    const stack = data(current,"stack");
    const frames: string[] = [];
    if(typeof stack === "string") for(const line of stack.slice(0,16384).split("\n").slice(1,33)) {
      const match = /^\s*at (?:(?:async )?([^()]+) \()?([^()\s]+):(\d+):(\d+)\)?$/.exec(line);
      if(!match) continue;
      const local = relative(root,match[2]).split(sep).join("/");
      if(local.startsWith("../") || local.includes(":")) continue;
      const file = (root.endsWith(sep+"build") ? "build/" : "src/")+local;
      const candidate = (match[1] || "").trim().split(".").at(-1) || "<anonymous>";
      const fn = LOG_SOURCE_FUNCTIONS[file]?.includes(candidate) ? candidate : "<anonymous>";
      const safe = frame(file,fn,match[3],match[4]);
      if(safe && frames.join("\n").length + safe.length + 1 <= 1024) frames.push(safe);
      if(frames.length===8) break;
    }
    if (depth) delete out.causeStack;
    out[depth ? "causeType" : "errorType"] = type;
    if(frames.length) out[depth ? "causeStack" : "errorStack"] = frames.join("\n");
    current = data(current,"cause");
  }
  return out;
}
