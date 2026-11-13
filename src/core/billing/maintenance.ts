import * as schedule from "node-schedule";
import config from "../../config";
import { BillingEvent, BillingAccount } from "./models";
import { processBillingInbox, billingHealth, billingFailure } from "./events";
import { reconcileBillingAccounts } from "./reconciliation";
import { rememberConfiguredPrices } from "./stripe";
import { createLogger } from "../logger";
const logger = createLogger("billing");
export async function startBillingMaintenance() {
  if (!config.BILLING_ENABLED) return;
  await Promise.all([BillingEvent.createIndexes(), BillingAccount.createIndexes()]);
  await rememberConfiguredPrices();
  let eventsRunning = false;
  let reconcileRunning = false;
  const events = async () => {
    if (eventsRunning) return;
    eventsRunning = true;
    try { await processBillingInbox(); }
    catch (error) { logger.error("billing worker failed", { code: billingFailure(error) }); }
    finally { eventsRunning = false; }
  };
  const reconcile = async () => {
    if (reconcileRunning) return;
    reconcileRunning = true;
    try {
      await reconcileBillingAccounts();
      const health = await billingHealth();
      if (health.failed || health.oldestPendingSeconds > 300 || health.unresolved || health.reconciliationFailed) logger.error("billing requires attention", health);
      // Remove routing envelopes after 90 days; retain failures for investigation.
      await BillingEvent.deleteMany({ state: "complete", completedAt: { $lt: new Date(Date.now() - 90 * 86400_000) } });
    } catch (error) { logger.error("billing maintenance failed", { code: billingFailure(error) }); }
    finally { reconcileRunning = false; }
  };
  schedule.scheduleJob("*/10 * * * * *", events);
  schedule.scheduleJob("*/5 * * * *", reconcile);
  void events();
  void reconcile();
}
