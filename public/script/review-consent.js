// Read once, before the router or application requests can observe the fragment.
export function takeReviewFragment(browser) {
  const fragment = browser.location.hash.slice(1);
  browser.history.replaceState(null, "", "/review-link");
  if (fragment.length > 2048) return null;
  const values = new URLSearchParams(fragment);
  if ([...values.keys()].length !== 3 || [...values.keys()].some(key => !["clientId", "intentId", "token"].includes(key))) return null;
  const clientId = values.get("clientId"), intentId = values.get("intentId"), token = values.get("token");
  if (!/^[a-f0-9]{32}$/.test(clientId || "") || !/^[a-f0-9]{32}$/.test(intentId || "") || !/^[a-f0-9]{64}$/.test(token || "")) return null;
  return { contract: "4open.artifacts/1", clientId, intentId, token };
}

export function reviewConsentController(state, services) {
  const { http, promises, window: browser } = services;
  let handoff = services.takeReviewHandoff();
  let ticket, csrf, confirmId, consumeId, identity;
  let active = true, expiryTimer;
  const stop = promises.defer();
  const requestId = () => [...browser.crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  Object.assign(state, { repositoryId: "", busy: false, preview: null, acceptAccess: false, acceptRetention: false, uncertain: false, saved: false, expired: false, error: handoff ? "" : "Open a new artifact link from your submission. This link is missing or invalid." });
  const current = () => active && state.user?.username === identity;
  function dispose() {
    active = false; handoff = ticket = csrf = undefined;
    stop.resolve(); browser.clearTimeout(expiryTimer);
  }
  state.on("dispose", dispose);
  state.on("routeLeave", dispose);
  state.watch(() => state.user?.username, username => {
    if (!identity && username) identity = username;
    else if (identity && username !== identity) {
      dispose(); state.preview = null; state.busy = false;
      state.error = "Your account changed. Open a new artifact link from your submission.";
    }
  });
  const options = () => ({ timeout: stop.promise, headers: { "Content-Type": "application/json", "X-Review-CSRF": csrf } });
  const message = error => error?.status === 404 ? "Artifact linking is not available on this server." : error?.status === 401 ? "Sign in, then open a new artifact link from your submission." : error?.status === 403 ? "This account cannot approve this repository or this link." : "The request could not be completed. You can retry from this page.";
  state.loadPreview = async () => {
    if (!active || !handoff || state.busy || state.uncertain || state.saved || !state.user?.username) return;
    identity = state.user.username;
    const repositoryId = state.repositoryId.trim();
    if (!/^[A-Za-z0-9_-]{3,128}$/.test(repositoryId)) { state.error = "Enter the anonymous repository ID from its URL."; return; }
    state.busy = true; state.error = ""; state.preview = null; ticket = undefined;
    state.acceptAccess = state.acceptRetention = false; state.expired = false;
    browser.clearTimeout(expiryTimer);
    consumeId ||= requestId();
    try {
      csrf = (await http.get("/api/review-consent/csrf", { timeout: stop.promise })).data.csrf;
      if (!current()) return;
      if (!/^[a-f0-9]{64}$/.test(csrf || "")) throw new Error("invalid_csrf");
      const result = (await http.post("/api/review-consent/preview", { repositoryId, intent: { ...handoff, requestId: consumeId } }, options())).data;
      if (!current()) return;
      if (!result || typeof result.ticket !== "string" || !result.ticket || result.ticket.length > 8192 || typeof result.repositoryName !== "string" || !["restricted-review", "anonymous-link"].includes(result.policy?.access) || !Number.isSafeInteger(result.policy.version) || !Number.isFinite(Date.parse(result.policy.retainUntil)) || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= Date.now() || Date.parse(result.expiresAt) > Date.now() + 600000) throw new Error("invalid_preview");
      ticket = result.ticket; confirmId = requestId();
      state.preview = { repositoryName: result.repositoryName, policy: { ...result.policy }, expiresAt: result.expiresAt };
      expiryTimer = browser.setTimeout(() => { if (active) state.expired = true; }, Math.max(0, Date.parse(result.expiresAt) - Date.now()));
    } catch (error) { if (current()) state.error = message(error); }
    finally { if (current()) state.busy = false; }
  };
  state.confirmConsent = async () => {
    if (!current() || state.busy || state.saved || !ticket || !state.acceptAccess || !state.acceptRetention) return;
    if (Date.parse(state.preview.expiresAt) <= Date.now()) { state.expired = true; return; }
    state.busy = true; state.error = "";
    try {
      const result = (await http.post("/api/review-consent/confirm", { ticket, requestId: confirmId, acceptAccess: true, acceptRetention: true }, options())).data;
      if (!current()) return;
      if (result?.requestId !== confirmId || !Number.isFinite(Date.parse(result.confirmedAt))) throw new Error("invalid_receipt");
      state.saved = true; state.uncertain = false; handoff = ticket = undefined;
    } catch (error) {
      if (current()) { state.uncertain = true; state.error = "The confirmation was not verified. Retry with the same approval, or return to your submission to check its status."; }
    } finally { if (current()) state.busy = false; }
  };
}
