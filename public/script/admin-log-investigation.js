import { nextTick } from "vue";

// Central counts never include the separately displayed Redis mirror.
export function installLogInvestigation(state, http) {
  state.errorSource = "central";
  state.logView = { search: "", severity: "", sort: "recent" };
  state.selectedLog = null;
  state.logSeverity = (sample) => Number(sample?.status || sample?.httpStatus) >= 500 || ["error", "fatal"].includes(sample?.severity) ? "error" : sample?.severity === "warn" ? "warn" : "info";
  state.filteredLogGroups = () => {
    const search = state.logView.search.trim().toLowerCase();
    return (state.logData?.groups || []).filter(group =>
      (!state.logView.severity || state.logSeverity(group.sample) === state.logView.severity) &&
      (!search || Object.values(group.sample).join(" ").toLowerCase().includes(search))
    ).slice().sort((a, b) => state.logView.sort === "count" ? b.count - a.count : Date.parse(b.last) - Date.parse(a.last));
  };
  state.shortLogId = id => id ? id.slice(0, 8) : "";
  let traceOrigin = null, detailOrigin = null, traceSource = null;
  state.selectLog = async (group, origin) => {
    detailOrigin = origin || document.activeElement;
    state.selectedLog = group;
    await nextTick();
    document.getElementById("log-detail-title")?.focus({ preventScroll: true });
    detailOrigin?.closest("tr")?.scrollIntoView?.({ block: "start" });
  };
  state.closeLogDetail = async () => {
    state.selectedLog = null;
    await nextTick();
    if (detailOrigin?.isConnected) detailOrigin.focus();
    else document.getElementById("error-source-central")?.focus();
  };
  state.logFilters = { window: "1h", service: "", release: "" };
  state.logAppliedFilters = { ...state.logFilters };
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
    ready: "Central logs available", empty: "No warnings, errors or HTTP 5xx returned in this window",
    disabled: "Central lookup is not configured. Application history is available in the other source.",
    misconfigured: "Central lookup configuration is invalid. Ask an operator to check it.",
    unreachable: "Central logging is unreachable. Application history is available in the other source.",
    busy: "Central lookup is busy. Retry shortly.", partial: "Partial results: a result limit or invalid record reduced coverage.",
    stale: "Central logging responds, but expected application telemetry is stale or missing.",
  }[value] || "Central log status has not been checked");
  state.refreshLogs = async () => {
    const current = ++version;
    const filters = { ...state.logFilters };
    state.logLoading = true; state.logFailure = "";
    state.trace = null; state.traceSelection = null; state.traceLoading = false; state.selectedLog = null; traceVersion++;
    try {
      const response = await http.get("/api/admin/errors/investigation", { params: filters });
      if (disposed || current !== version) return;
      state.logData = response.data;
      state.logAppliedFilters = filters;
      state.logSnapshotStale = !!response.data?.end && Date.now() - Date.parse(response.data.end) > 90000;
    } catch (error) {
      if (disposed || current !== version) return;
      state.logData = null;
      state.logFailure = error?.status === 400 ? "Use a Git release SHA or ‘unknown’ and retry." : "Could not load central log status. Retry or open Application history.";
    } finally { if (!disposed && current === version) state.logLoading = false; }
  };
  state.lookupTrace = async (kind, id, origin, sample) => {
    if (!["requestId", "jobId"].includes(kind) || !uuid.test(id || "")) return;
    traceSource = state.errorSource;
    traceOrigin = origin || document.activeElement;
    const current = ++traceVersion;
    state.traceSelection = { kind, id, context: sample ? {
      event: sample.errorCode || sample.event || sample.displayMessage || sample.message,
      service: sample.service || sample.module,
    } : null }; state.trace = null; state.traceLoading = true;
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
  state.closeTrace = async () => {
    traceVersion++; state.trace = null; state.traceSelection = null; state.traceLoading = false;
    await nextTick();
    if (traceOrigin?.isConnected && traceSource === state.errorSource) traceOrigin.focus();
    else document.getElementById("error-source-" + state.errorSource)?.focus();
  };
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
