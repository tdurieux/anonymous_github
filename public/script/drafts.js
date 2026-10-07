// Drafts stay in this browser tab and are tied to the signed-in account.
export function formDraft(state, fields, key) {
  let baseline;
  let watching = false;
  const storageKey = "form-draft:" + key;
  const values = () => Object.fromEntries(fields.map(field => [field, state[field]]));
  const serialize = () => JSON.stringify(values());
  const apply = (saved) => {
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(saved, field)) state[field] = saved[field];
    }
    if (state.options?.expirationDate) state.options.expirationDate = new Date(state.options.expirationDate);
  };
  const remove = () => { try { window.sessionStorage.removeItem(storageKey); } catch { /* Storage may be disabled. */ } };
  const save = (flush = false) => {
    if (baseline === undefined) return;
    if (flush) document.querySelectorAll("input, select, textarea").forEach(el => {
        if (el._field?.binding.state === state && el._field.timer) el._field.commit();
      });
    state.unsavedChanges = serialize() !== baseline;
    state.draftSaved = false;
    if (!state.unsavedChanges) { remove(); return; }
    try {
      window.sessionStorage.setItem(storageKey, JSON.stringify({
        account: state.user?.username || null, savedAt: Date.now(), values: values(),
      }));
      state.draftSaved = true;
    } catch { /* Keep the form usable when storage is disabled or full. */ }
  };
  const saveBeforeLeaving = () => save(true);
  state.on("routeLeave", saveBeforeLeaving);
  window.addEventListener("beforeunload", saveBeforeLeaving);
  state.on("dispose", () => window.removeEventListener("beforeunload", saveBeforeLeaving));
  return {
    restore() {
      baseline = serialize();
      let saved;
      try { saved = JSON.parse(window.sessionStorage.getItem(storageKey) || "null"); } catch { /* Ignore invalid drafts. */ }
      const restored = saved && saved.account === (state.user?.username || null)
        && Date.now() - saved.savedAt < 30 * 60000 && saved.values;
      if (restored) {
        apply(saved.values);
        state.draftRestored = true;
      }
      if (!watching) {
        watching = true;
        state.watch(() => values(), () => save(), true);
      }
      state.unsavedChanges = serialize() !== baseline;
      return !!restored;
    },
    checkpoint() { return JSON.parse(serialize()); },
    accept(saved) {
      baseline = JSON.stringify(saved);
      state.draftRestored = false;
      save();
    },
    discard() {
      document.querySelectorAll("input, select, textarea").forEach(el => {
        if (el._field?.binding.state !== state || !el._field.timer) return;
        clearTimeout(el._field.timer);
        el._field.timer = null;
        el.value = el._field.binding.value ?? "";
      });
      if (baseline !== undefined) apply(JSON.parse(baseline));
      state.draftRestored = false;
      save();
    },
    clear() {
      baseline = serialize();
      state.unsavedChanges = false;
      state.draftRestored = false;
      state.draftSaved = false;
      remove();
    },
  };
}
