import { nextTick } from "vue";

// Central counts never include the separately displayed Redis mirror.
export function installLogInvestigation(state, http) {
  state.logFilters = { window: "1h", service: "", release: "" };
  state.logData = null;
  state.logLoading = false;
  state.logFailure = "";
  state.logSnapshotStale = false;
  state.trace = null;
  state.traceLoading = false;
  state.traceSelection = null;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  let version = 0, traceVersion = 0, disposed = false;
  state.logStateText = (value) => ({
    ready: "Central logs available", empty: "No warnings or errors in this window",
    disabled: "Central lookup is not configured. Redis history remains available below.",
    misconfigured: "Central lookup configuration is invalid. Ask an operator to check it.",
    unreachable: "Central logging is unreachable. Redis history remains available below.",
    busy: "Central lookup is busy. Retry shortly.", partial: "Partial results: a result limit or invalid record reduced coverage.",
    stale: "Central logging responds, but expected application telemetry is stale or missing.",
  }[value] || "Central log status has not been checked");
  state.refreshLogs = async () => {
    const current = ++version;
    state.logLoading = true; state.logFailure = "";
    state.trace = null; state.traceSelection = null; state.traceLoading = false; traceVersion++;
    try {
      const response = await http.get("/api/admin/errors/investigation", { params: { ...state.logFilters } });
      if (disposed || current !== version) return;
      state.logData = response.data;
      state.logSnapshotStale = !!response.data?.end && Date.now() - Date.parse(response.data.end) > 90000;
    } catch (error) {
      if (disposed || current !== version) return;
      state.logData = null;
      state.logFailure = error?.status === 400 ? "Use a Git release SHA or ‘unknown’ and retry." : "Could not load central log status. Retry or use Redis history below.";
    } finally { if (!disposed && current === version) state.logLoading = false; }
  };
  state.lookupTrace = async (kind, id) => {
    if (!["requestId", "jobId"].includes(kind) || !uuid.test(id || "")) return;
    const current = ++traceVersion;
    state.traceSelection = { kind, id }; state.trace = null; state.traceLoading = true;
    await nextTick();
    const heading = document.getElementById("log-timeline-title");
    heading?.focus();
    heading?.scrollIntoView?.({ block: "nearest" });
    try {
      const response = await http.get("/api/admin/errors/correlation", { params: { kind, id, window: state.logData?.window || state.logFilters.window } });
      if (!disposed && current === traceVersion) state.trace = response.data;
    } catch {
      if (!disposed && current === traceVersion) state.trace = { state: "unreachable", events: [] };
    } finally { if (!disposed && current === traceVersion) state.traceLoading = false; }
  };
  state.closeTrace = () => { traceVersion++; state.trace = null; state.traceSelection = null; state.traceLoading = false; };
  state.logTraceId = (row, kind) => {
    const value = row?.sample?.[kind] || row?.raw?.find(value => value && typeof value === "object")?.[kind];
    return uuid.test(value || "") ? value : null;
  };
  const freshnessTimer = window.setInterval(() => {
    state.logSnapshotStale = !!state.logData?.end && Date.now() - Date.parse(state.logData.end) > 90000;
  }, 15000);
  state.on("dispose", () => { disposed = true; version++; traceVersion++; window.clearInterval(freshnessTimer); });
  state.refreshLogs();
}
