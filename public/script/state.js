import { reactive, watch, nextTick, onScopeDispose } from "vue";

export function getPath(object, path) {
  return path?.split(".").reduce((value, key) => value?.[key], object);
}

// Page state inherits the shared session without copying it. All mutations are
// tracked by Vue, including those made by fetch callbacks and browser events.
export function createPageState(parent = null, events = new Map()) {
  const own = reactive({});
  const cleanups = [];
  let disposed = false;
  const state = new Proxy(own, {
    get(target, key) {
      // Forward Vue metadata so writes through this proxy notify render effects.
      if ((typeof key === "string" && key.startsWith("__v_")) || Reflect.has(target, key)) return Reflect.get(target, key);
      return parent?.[key];
    },
  });
  Object.defineProperty(own, "parent", { value: parent, configurable: true });
  Object.defineProperty(own, "viewState", { get: () => state });
  state.watch = (source, callback, deep = false) => {
    const read = typeof source === "function" ? () => source(state) : () => getPath(state, source);
    const stop = watch(read, callback, { deep, flush: "post" });
    cleanups.push(stop);
    nextTick(() => { if (!disposed) callback(read(), read()); });
    return stop;
  };
  state.watchGroup = (sources, callback) => state.watch(() => sources.map(s => getPath(state, s)), callback, true);
  state.on = (name, callback) => {
    if (name === "dispose") { cleanups.push(callback); return () => {}; }
    if (!events.has(name)) events.set(name, new Set());
    events.get(name).add(callback);
    const off = () => events.get(name)?.delete(callback);
    cleanups.push(off);
    return off;
  };
  state.emit = (name, ...args) => {
    for (const callback of [...(events.get(name) || [])]) callback({}, ...args);
  };
  state.dispose = () => {
    disposed = true;
    cleanups.splice(0).reverse().forEach(fn => fn());
  };
  onScopeDispose(state.dispose);
  return state;
}

export function createTimers() {
  const timeouts = new Set();
  const intervals = new Set();
  let disposed = false;
  const timeout = (callback, delay = 0) => {
    if (disposed) return;
    const id = setTimeout(() => { timeouts.delete(id); callback(); }, delay);
    timeouts.add(id);
    return id;
  };
  timeout.cancel = id => { clearTimeout(id); timeouts.delete(id); };
  const interval = (callback, delay) => {
    if (disposed) return;
    const id = setInterval(callback, delay);
    intervals.add(id);
    return id;
  };
  interval.cancel = id => { clearInterval(id); intervals.delete(id); };
  onScopeDispose(() => { disposed = true; timeouts.forEach(clearTimeout); intervals.forEach(clearInterval); });
  return { timeout, interval };
}

export function createListeners() {
  const cleanups = [];
  onScopeDispose(() => cleanups.forEach(fn => fn()));
  return (target, type, callback, options) => {
    target.addEventListener(type, callback, options);
    cleanups.push(() => target.removeEventListener(type, callback, options));
  };
}
