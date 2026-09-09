const pending = new Map();
// Generated from the completed library bundles, so deployments invalidate caches.
const assets = __LAZY_ASSETS__;
export function loadLibrary(name) {
  if (!pending.has(name)) {
    const script = document.createElement("script");
    script.src = assets[name];
    const promise = new Promise((resolve, reject) => {
      script.onload = resolve;
      script.onerror = () => {
        pending.delete(name);
        script.remove();
        reject(new Error(`Unable to load ${name}. Please retry.`));
      };
    });
    pending.set(name, promise);
    document.head.appendChild(script);
  }
  return pending.get(name);
}
export async function loadEditor() {
  await loadLibrary("editor");
  ace.config.set("basePath", "/script/external/ace/");
}
