import { nextTick } from "vue";

// Central counts never include the separately displayed Redis mirror.
export function installLogInvestigation(state, http) {
  state.errorSource = "central";
  state.logView = { search: "", severity: "", sort: "recent" };
  state.selectedLog = null;
  state.logDetailTab = "overview";
  state.logSeverity = (sample) => Number(sample?.status || sample?.httpStatus) >= 500 || ["error", "fatal"].includes(sample?.severity) ? "error" : sample?.severity === "warn" ? "warn" : "info";
  state.filteredLogGroups = () => {
    const search = state.logView.search.trim().toLowerCase();
    return (state.logData?.groups || []).filter(group =>
      (!state.logView.severity || state.logSeverity(group.sample) === state.logView.severity) &&
      (!search || Object.values(group.sample).join(" ").toLowerCase().includes(search))
    ).slice().sort((a, b) => state.logView.sort === "count" ? b.count - a.count : Date.parse(b.last) - Date.parse(a.last));
  };
  state.shortLogId = id => id ? id.slice(0, 8) : "";
  state.isLogIdentifier = (key, value) => typeof value === "string" && value.length > 16 && /(?:id|sha|release)$/i.test(key);
  state.compactLogValue = value => String(value).slice(0, 8) + "…" + String(value).slice(-4);
  state.logCopyStatus = "";
  state.copyLogValue = async value => {
    try { await navigator.clipboard.writeText(String(value)); state.logCopyStatus = "Full value copied"; }
    catch { state.logCopyStatus = "Copy unavailable. Expand the value to select it."; }
  };
  state.logExplanation = sample => {
    const service = sample.service || "The application";
    const event = ({job_failed:"reported a failed job",request_failed:"reported a failed request",request_aborted:"reported an aborted request",edge_request:"recorded an edge request",http_access:"recorded an HTTP request"})[sample.event] || ("recorded “" + (sample.event || "application event") + "”");
    const status = Number(sample.status || sample.httpStatus);
    const meaning = ({502:"Bad Gateway",503:"Service Unavailable",504:"Gateway Timeout"})[status];
    return service + " " + event + (status ? " with HTTP " + status + (meaning ? " (" + meaning + ")" : "") : "") + ".";
  };
  state.logEvidence = sample => [
    sample.errorCode ? "Recorded error code: " + sample.errorCode + "." : "No error code was included in this sample.",
    sample.ms !== undefined ? "Recorded duration: " + sample.ms + " ms." : "",
    sample.attempt !== undefined ? "Recorded attempt: " + sample.attempt + "." : "",
    sample.queue ? "Queue: " + sample.queue + "." : "",
  ].filter(Boolean).join(" ");
  state.occurrenceTime = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(undefined, {dateStyle:"medium",timeStyle:"medium"}) : "Time not captured";
  state.historyOccurrences = row => (row?._related || []).slice().sort((a,b) => Date.parse(b.ts)-Date.parse(a.ts));
  state.historyDetailFields = row => {
    try { const value = JSON.parse(row?._detailJson || "{}"); return value && typeof value === "object" ? Object.entries(value) : [["value", value]]; }
    catch { return [["record", row?._detailJson || ""]]; }
  };
  state.logFieldText = value => typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
  state.captureErrorScroll = origin => {
    const positions = [];
    for (let element = origin?.parentElement; element; element = element.parentElement) positions.push({element,top:element.scrollTop,left:element.scrollLeft});
    return positions;
  };
  state.restoreErrorScroll = positions => positions.forEach(({element,top,left}) => { if(element.isConnected) {element.scrollTop=top;element.scrollLeft=left;} });
  let traceOrigin = null, detailOrigin = null, traceSource = null, listScroll = [];
  state.selectLog = async (group, origin) => {
    detailOrigin = origin || document.activeElement;
    listScroll = state.captureErrorScroll(detailOrigin);
    traceVersion++; state.trace = null; state.traceSelection = null; state.traceLoading = false;
    state.logDetailTab = "overview";
    state.selectedLog = group;
    await nextTick();
    if (disposed || state.selectedLog !== group || state.errorSource !== "central") return;
    document.getElementById("log-detail-title")?.focus({ preventScroll: true });
    document.querySelector(".log-inspector")?.scrollIntoView?.({ block: "start" });
    const kind = ["requestId","jobId"].find(key=>state.logTraceId(group,key));
    if (kind) state.lookupTrace(kind,group.sample[kind],document.getElementById("trace-selector-"+kind),group.sample,true);
  };
  state.closeLogDetail = async () => {
    state.selectedLog = null;
    traceVersion++; state.trace = null; state.traceSelection = null; state.traceLoading = false;
    await nextTick();
    if (detailOrigin?.isConnected) { detailOrigin.focus({preventScroll:true}); state.restoreErrorScroll(listScroll); }
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
  state.lookupTrace = async (kind, id, origin, sample, preserveFocus = false) => {
    if (!["requestId", "jobId"].includes(kind) || !uuid.test(id || "")) return;
    if (state.errorSource === "central" && state.selectedLog) state.logDetailTab = "timeline";
    if (state.errorSource === "history") state.historyView = "timeline";
    traceSource = state.errorSource;
    traceOrigin = origin || document.activeElement;
    const current = ++traceVersion;
    state.traceSelection = { kind, id, context: sample ? {
      event: sample.errorCode || sample.event || sample.displayMessage || sample.message,
      service: sample.service || sample.module,
    } : null }; state.trace = null; state.traceLoading = true;
    await nextTick();
    if (disposed || current !== traceVersion) return;
    const heading = document.getElementById("log-timeline-title");
    if (!preserveFocus) { heading?.focus(); heading?.scrollIntoView?.({ block: "nearest" }); }
    try {
      const response = await http.get("/api/admin/errors/correlation", { params: { kind, id, window: state.logData?.window || state.logAppliedFilters.window } });
      if (!disposed && current === traceVersion) state.trace = response.data;
    } catch {
      if (!disposed && current === traceVersion) state.trace = { state: "unreachable", events: [] };
    } finally { if (!disposed && current === traceVersion) state.traceLoading = false; }
  };
  state.showLogTimeline = origin => {
    state.logDetailTab = "timeline";
    if (state.traceSelection) return;
    const kind = ["requestId","jobId"].find(key=>state.logTraceId(state.selectedLog,key));
    if (kind) state.lookupTrace(kind,state.selectedLog.sample[kind],origin,state.selectedLog.sample);
  };
  state.closeTrace = async () => {
    state.logDetailTab = "overview";
    state.historyView = "overview";
    traceVersion++; state.trace = null; state.traceSelection = null; state.traceLoading = false;
    await nextTick();
    if (traceOrigin?.isConnected && traceSource === state.errorSource) traceOrigin.focus();
    else document.getElementById("error-source-" + state.errorSource)?.focus();
  };
  state.logTraceId = (row, kind) => {
    const value = row?.sample?.[kind] || row?.raw?.find(value => value && typeof value === "object")?.[kind];
    return uuid.test(value || "") ? value : null;
  };
  state.watch("errorSource", () => {
    traceVersion++; state.trace = null; state.traceSelection = null; state.traceLoading = false; state.selectedLog = null; state.historySelected = null; state.historyView = "overview"; state.expanded = {};
  }, false, false);
  const freshnessTimer = window.setInterval(() => {
    state.logSnapshotStale = !!state.logData?.end && Date.now() - Date.parse(state.logData.end) > 90000;
  }, 15000);
  state.on("dispose", () => { disposed = true; version++; traceVersion++; window.clearInterval(freshnessTimer); });
  state.refreshLogs();
}
