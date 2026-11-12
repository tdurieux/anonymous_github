// One-time purchases that apply to a single repository.
export function isRepositoryAddon(planId) { return ["author_pass", "repo_extend", "repo_never", "repo_slot", "repo_pack"].includes(planId); }
// Share concurrent catalog reads between the app header and the current page.
const billingReads = new WeakMap();
export function readBilling(http) {
  if (!billingReads.has(http)) {
    const request = http.get("/api/billing/").finally(() => billingReads.delete(http));
    billingReads.set(http, request);
  }
  return billingReads.get(http);
}
export function setupBilling(state, http, onRefresh = () => {}, context = {}) {
  const outcome = new URLSearchParams(window.location.search).get("billing");
  state.billing = null;
  state.billingLoading = true;
  state.billingBusy = false;
  state.billingError = "";
  state.billingNotice = "";
  // Only a completed checkout waits for payment confirmation. Returning from
  // the billing portal (cancelling renewal, downloading an invoice) does not.
  state.billingPending = outcome === "success";
  state.billingRepository = "";
  const messages = {
    billing_invalid_draft: "This draft could not be saved. Your form is unchanged. Try again.",
    billing_draft_not_found: "This checkout draft is unavailable or expired. Your local form is unchanged.",
    billing_recovery_required: "Your earlier payment needs verification. Please contact support before paying again.",
    billing_checkout_disabled: "New purchases are temporarily unavailable. You can still manage existing billing.",
    billing_unavailable: "Payments are not available yet. Please try again later.",
    billing_subscription_exists: "You already have a subscription. Use Manage billing to change or cancel it.",
    billing_checkout_in_progress: "You have another checkout open. Complete it, or wait up to 30 minutes for it to expire, before choosing a different option.",
    billing_busy: "Another billing request is processing. Please try again shortly.",
    billing_already_paid: "This repository or conference already has this paid option.",
    billing_invalid_review_window: "Conference packages cover up to 180 days. Check the review dates.",
    billing_invalid_conference: "Only a conference owner can pay for a conference awaiting payment.",
    repo_not_found: "Enter the ID of an existing repository that you own.",
  };
  // Whole amounts read as "€5", not "€5.00".
  state.billingAmount = plan => plan?.amount == null ? "" : new Intl.NumberFormat(undefined, { style: "currency", currency: plan.currency,
    minimumFractionDigits: plan.amount % 100 ? 2 : 0, maximumFractionDigits: 2 }).format(plan.amount / 100);
  state.billingPrice = plan => {
    if (plan.amount == null) return "Price shown at checkout";
    const amount = state.billingAmount(plan);
    return amount + (plan.interval ? ` / ${plan.intervalCount > 1 ? plan.intervalCount + " " : ""}${plan.interval}` : " once");
  };
  state.billingPerMonth = plan => plan?.amount == null ? "" : new Intl.NumberFormat(undefined, { style: "currency", currency: plan.currency }).format(plan.amount / 1200);
  state.billingBytes = value => {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    const exponent = Math.min(4, Math.floor(Math.log2(bytes) / 10));
    return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / 1024 ** exponent)} ${["B", "KiB", "MiB", "GiB", "TiB"][exponent]}`;
  };
  state.billingDate = value => value ? new Date(value).toLocaleDateString() : "";
  state.loadBilling = () => { state.billingError = ""; state.billingLoading = true; return readBilling(http).then(res => { state.billing = res.data; state.emit?.("billing:updated", res.data); })
    .catch(() => { state.billingError = "Billing could not be loaded. Try again."; })
    .finally(() => { state.billingLoading = false; }); };
  async function action(path, body, redirect = true) {
    if (state.billingBusy || !state.billing?.csrf) return;
    state.billingBusy = true;
    state.billingError = "";
    try {
      const response = await http.post(`/api/billing/${path}`, body, { headers: { "x-csrf-token": state.billing.csrf } });
      if (redirect) window.location.assign(response.data.url);
      else {
        await state.loadBilling();
        await onRefresh();
        state.billingPending = !!response.data.pending;
        state.emit?.("billing:pending", state.billingPending);
        state.billingNotice = response.data.pending ? "Your payment is still pending. Please do not pay again." : (context.confirmedMessage || "Billing status refreshed. Your confirmed access appears below.");
        return response.data;
      }
    } catch (error) { state.billingError = messages[error.data?.error] || "The billing request failed. Please try again."; }
    finally { state.billingBusy = false; }
  }
  state.checkout = (planId, target = "", extra = {}) => action("checkout", { planId, target, ...extra });
  state.billingPortal = () => action("portal", {});
  state.refreshBilling = () => action("refresh", {}, false);
  async function confirmPayment() {
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await state.refreshBilling();
      if (!result || !result.pending) return;
      await new Promise(resolve => window.setTimeout(resolve, 3000));
    }
    state.billingNotice = "Confirmation is taking longer than usual. You can refresh payment status later. Please do not pay again.";
  }
  state.loadBilling().then(() => {
    if (outcome === "success") {
      state.billingNotice = "Checking your payment. Paid access starts after confirmation.";
      confirmPayment();
    } else if (outcome === "portal") {
      state.refreshBilling().then(() => {
        state.billingPending = false;
        state.emit?.("billing:pending", false);
        state.billingNotice = context.portalMessage?.(state.billing) || "Your billing details are up to date.";
      });
    } else if (outcome === "cancelled") state.billingNotice = "Checkout was closed. No new paid access has been activated.";
  });
}
