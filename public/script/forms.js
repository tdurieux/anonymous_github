import { reactive } from "vue";

function validationState() {
  return reactive({
    errors: {}, dirty: false, touched: false, submitted: false,
    get invalid() { return Object.values(this.errors).some(Boolean); },
    setValidity(key, valid) { this.errors[key] = !valid; },
    setDirty() { this.dirty = true; },
  });
}
function ensureForm(state, name) {
  if (!state[name]) {
    const form = validationState();
    Object.defineProperty(form, "invalid", { get() {
      return Object.values(form.errors).some(Boolean) || Object.keys(form).some(key => key !== "invalid" && form[key] && typeof form[key] === "object" && form[key].invalid);
    } });
    state[name] = form;
  }
  return state[name];
}
export const formDirective = {
  beforeMount(el, { value: state }) {
    el._formState = ensureForm(state, el.name);
    el.addEventListener("submit", event => event.preventDefault());
  },
};
function dateInput(value) {
  if (!(value instanceof Date)) return value || "";
  if (isNaN(value)) return "";
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}
function sync(el) {
  const value = el._field.binding.value;
  if (el.type === "checkbox") el.checked = !!value;
  else if (el.type === "radio") el.checked = value == (el._value ?? el.value);
  else if (!el._field.timer) el.value = el.type === "date" ? dateInput(value) : value ?? "";
  validate(el);
}
function validate(el) {
  const field = el._field.validation;
  if (!field) return;
  const validity = el.validity;
  for (const [key, invalid] of Object.entries({ required: validity.valueMissing, pattern: validity.patternMismatch, min: validity.rangeUnderflow, max: validity.rangeOverflow, date: validity.badInput, email: validity.typeMismatch && el.type === "email", url: validity.typeMismatch && el.type === "url" })) {
    field.setValidity(key, el.disabled || !invalid);
  }
}
export const fieldDirective = {
  beforeMount(el, { value: binding }) {
    const form = binding.form && ensureForm(binding.state, binding.form);
    const validation = form && el.name ? (form[el.name] ||= validationState()) : null;
    el._field = { binding, validation, timer: null };
    const commit = () => {
      clearTimeout(el._field.timer); el._field.timer = null;
      const binding = el._field.binding;
      let value = el.type === "checkbox" ? el.checked : el._value ?? el.value;
      if (el.type === "radio" && !el.checked) return;
      if (el.type === "number" || el.type === "range") value = el.value === "" ? null : Number(el.value);
      if (el.type === "date") value = el.value ? new Date(el.value + "T00:00:00") : null;
      if (validation) {
        validation.setDirty();
        for (const key of Object.keys(validation.errors)) validation.setValidity(key, true);
      }
      binding.set(value);
      validate(el);
      binding.change?.();
    };
    el._field.commit = commit;
    const update = event => {
      const debounce = el._field.binding.options?.debounce || 0;
      const delay = typeof debounce === "number" ? debounce : debounce[event.type] ?? debounce.default ?? 0;
      clearTimeout(el._field.timer);
      if (delay) el._field.timer = setTimeout(commit, delay);
      else commit();
    };
    el.addEventListener(el.tagName === "SELECT" || ["checkbox", "radio", "date"].includes(el.type) ? "change" : "input", update);
    el.addEventListener("blur", () => { if (validation) validation.touched = true; if (el._field.timer) commit(); });
  },
  mounted: sync,
  updated(el, { value }) { el._field.binding = value; sync(el); },
  beforeUnmount(el) {
    clearTimeout(el._field.timer);
    const { binding, validation } = el._field;
    const form = binding.form && binding.state[binding.form];
    if (form && form[el.name] === validation) delete form[el.name];
  },
};
export function submitForm(event, callback) {
  const form = event.target.closest("form");
  if (form?._formState) form._formState.submitted = true;
  form?.querySelectorAll("input, select, textarea").forEach(el => {
    if (el._field?.timer) el._field.commit();
    if (el._field) validate(el);
  });
  if (form && !form.checkValidity()) {
    const invalid = form.querySelector(":invalid");
    invalid?.scrollIntoView?.({ block: "center" });
    invalid?.focus();
    form.reportValidity();
    return;
  }
  return callback();
}
