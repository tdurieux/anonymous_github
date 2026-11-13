const { setTimeout } = require("node:timers");
// Explicit opt-in integration test. Creates only tagged sandbox objects.
// Credentials live outside the repository; never log Stripe errors verbatim.
const fs = require("node:fs");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
require("ts-node/register/transpile-only");
const mongoose = require("mongoose");
const Stripe = require("stripe");
const config = require("../src/config").default;
const { BillingAccount, BillingGrant, BillingQuota, BillingLock } = require("../src/core/billing/models");
const Repo = require("../src/core/model/anonymizedRepositories/anonymizedRepositories.model").default;
const Conference = require("../src/core/model/conference/conferences.model").default;
const { createCheckout, syncSubscription, fulfillCheckout, cancelAccountBilling } = require("../src/core/billing/stripe");
const { allowance } = require("../src/core/billing/quotas");
const { neverExpirationDeadline, reconcileNeverExpiration } = require("../src/core/billing/expiration");
const run = crypto.randomUUID();
const metadata = { application: "anonymous-github", sandbox_test_run: run };
const results = [];
const customers = [], prices = [], products = [], clocks = [];
let stripe;
async function check(name, fn) { await fn(); results.push(name); console.log("PASS " + name); }
async function customer() {
  const owner = new mongoose.Types.ObjectId().toString();
  const c = await stripe.customers.create({ metadata: { ...metadata, owner }, payment_method: "pm_card_visa", invoice_settings: { default_payment_method: "pm_card_visa" } });
  customers.push(c.id);
  await BillingAccount.create({ _id: owner, customerId: c.id });
  return { owner, id: c.id };
}
async function main() {
  const credentialsPath = process.env.STRIPE_SANDBOX_CREDENTIALS;
  if (!credentialsPath) throw new Error("Set STRIPE_SANDBOX_CREDENTIALS to a private JSON file");
  const { secret } = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
  if (typeof secret !== "string" || !secret.startsWith("sk_test_")) throw new Error("Sandbox secret key required");
  stripe = new Stripe(secret, { maxNetworkRetries: 2, timeout: 20000 });
  assert.equal((await stripe.balance.retrieve()).livemode, false);
  const uri = process.env.BILLING_TEST_MONGODB_URI;
  assert.match(new URL(uri).pathname, /^\/billing_test_/);
  await mongoose.connect(uri);
  await Promise.all([BillingAccount, BillingGrant, BillingQuota, BillingLock, Repo, Conference].map(m => m.init()));
  Object.assign(config, { BILLING_ENABLED: true, STRIPE_SECRET_KEY: secret,
    STRIPE_WEBHOOK_SECRET: crypto.randomBytes(32).toString("hex"), BILLING_ORIGIN: "http://localhost:5183", BILLING_AUTOMATIC_TAX: false });
  const product = await stripe.products.create({ name: "Anonymous GitHub sandbox integration " + run, metadata });
  products.push(product.id);
  for (const [key, amount, interval] of [
    ["STRIPE_AUTHOR_MONTHLY_PRICE",500,"month"],["STRIPE_AUTHOR_ANNUAL_PRICE",4900,"year"],
    ["STRIPE_AUTHOR_PASS_PRICE",400],["STRIPE_REPO_EXTEND_PRICE",200],["STRIPE_REPO_NEVER_PRICE",1000],["STRIPE_REPO_SLOT_PRICE",200],["STRIPE_REPO_PACK_PRICE",500],["STRIPE_CONFERENCE_SMALL_PRICE",4900],["STRIPE_CONFERENCE_PRICE",14900],["STRIPE_CONFERENCE_LARGE_PRICE",39900]]) {
    const p = await stripe.prices.create({ product: product.id, currency: "eur", unit_amount: amount, metadata, ...(interval ? { recurring: { interval } } : {}) });
    prices.push(p.id); config[key] = p.id;
  }
  const buyer = await customer();
  await Repo.create({ repoId: "sandbox-"+run, owner: buyer.owner, status: "ready" });
  await Conference.create({ conferenceID: "sandbox-"+run, owners: [buyer.owner], status: "pending_payment",
    startDate: new Date(), endDate: new Date(Date.now()+86400000*30), plan: { planID: "conference" } });
  for (const plan of ["author_monthly","author_annual","author_pass","repo_extend","repo_never","repo_slot","repo_pack","conference"]) {
    await check(plan + " Checkout creation, reuse, unpaid denial and expiry", async () => {
      const target = ["author_pass","repo_extend","repo_never","repo_slot","repo_pack","conference"].includes(plan) ? "sandbox-"+run : "";
      const url = await createCheckout(buyer.owner, plan, target, stripe);
      assert.match(url, /^https:\/\/checkout.stripe.com\//);
      assert.equal(await createCheckout(buyer.owner,plan,target,stripe), url);
      const account = await BillingAccount.findById(buyer.owner);
      await fulfillCheckout(account.checkout.id, stripe);
      assert.equal(await BillingGrant.countDocuments({ owner: buyer.owner }),0);
      await stripe.checkout.sessions.expire(account.checkout.id);
    });
  }
  for (const [plan,key] of [["author_monthly","STRIPE_AUTHOR_MONTHLY_PRICE"],["author_annual","STRIPE_AUTHOR_ANNUAL_PRICE"]]) {
    const c = await customer();
    const sub = await stripe.subscriptions.create({ customer:c.id, items:[{price:config[key]}], metadata:{...metadata,owner:c.owner} });
    await check(plan + " successful payment and entitlement",async()=>{
      await syncSubscription(sub.id,stripe);
      assert.equal((await allowance(c.owner)).plan,plan);
      assert.ok(await neverExpirationDeadline(c.owner));
    });
    await check(plan + " duplicate subscription prevention",async()=>{
      await assert.rejects(createCheckout(c.owner,plan,"",stripe),/billing_subscription_exists/);
    });
    await check(plan + " cancellation preserves paid period",async()=>{
      await stripe.subscriptions.update(sub.id,{cancel_at_period_end:true});
      await syncSubscription(sub.id,stripe);
      assert.equal((await allowance(c.owner)).plan,plan);
      assert.equal((await BillingGrant.findById(sub.id)).cancelAtPeriodEnd,true);
    });
    await check(plan + " immediate cancellation and grace expiry",async()=>{
      const deadline = await neverExpirationDeadline(c.owner);
      await Repo.create({repoId:plan+"-"+run,owner:c.owner,status:"ready",options:{expirationMode:"never"},billingNeverExpiresUntil:deadline});
      await stripe.subscriptions.cancel(sub.id);
      await syncSubscription(sub.id,stripe);
      assert.equal((await allowance(c.owner)).plan,"free");
      await reconcileNeverExpiration(new Date(deadline.getTime()-1));
      assert.equal((await Repo.findOne({owner:c.owner})).options.expirationMode,"never");
      await reconcileNeverExpiration(deadline);
      assert.equal((await Repo.findOne({owner:c.owner})).options.expirationMode,"remove");
    });
  }
  await check("declined initial payment grants no paid access",async()=>{
    const c=await customer();
    const pm=await stripe.paymentMethods.attach("pm_card_chargeCustomerFail",{customer:c.id});
    await stripe.customers.update(c.id,{invoice_settings:{default_payment_method:pm.id}});
    const sub=await stripe.subscriptions.create({customer:c.id,items:[{price:config.STRIPE_AUTHOR_MONTHLY_PRICE}],payment_behavior:"default_incomplete",metadata:{...metadata,owner:c.owner}});
    await syncSubscription(sub.id,stripe);
    assert.equal((await allowance(c.owner)).plan,"free");
    await assert.rejects(neverExpirationDeadline(c.owner),/subscription_required/);
  });

  await check("subscription refund revocation, signed event replay and tamper rejection",async()=>{
    const c=await customer();
    const sub=await stripe.subscriptions.create({customer:c.id,items:[{price:config.STRIPE_AUTHOR_MONTHLY_PRICE}],metadata:{...metadata,owner:c.owner}});
    await syncSubscription(sub.id,stripe);
    const payments=await stripe.invoicePayments.list({invoice:sub.latest_invoice});
    const pi=payments.data.find(p=>p.payment.type==="payment_intent").payment.payment_intent;
    const refund=await stripe.refunds.create({payment_intent:typeof pi==="string"?pi:pi.id});
    const charge=await stripe.charges.retrieve(refund.charge);
    const express=require("express");
    const app=express();
    app.use("/webhook",require("../src/server/routes/billing").billingWebhook);
    const server=await new Promise(resolve=>{const srv=app.listen(0,"127.0.0.1",()=>resolve(srv));});
    try {
      // Real Stripe charge payload; local signature exercises the production HTTP route.
      const payload=JSON.stringify({id:"evt_sandbox_"+run,type:"charge.refunded",data:{object:charge}});
      const signature=stripe.webhooks.generateTestHeaderString({payload,secret:config.STRIPE_WEBHOOK_SECRET});
      const post=body=>globalThis.fetch("http://127.0.0.1:"+server.address().port+"/webhook",{method:"POST",headers:{"content-type":"application/json","stripe-signature":signature},body});
      assert.equal((await post(payload)).status,200);
      assert.equal((await post(payload)).status,200);
      assert.equal((await post(payload+" ")).status,400);
      await require("../src/core/billing/events").processBillingInbox();
      assert.equal((await allowance(c.owner)).plan,"free");
      await syncSubscription(sub.id,stripe);
      assert.equal((await allowance(c.owner)).plan,"free");
    } finally { server.closeAllConnections();await new Promise(resolve=>server.close(resolve)); }
  });
  await check("subscription renewal, failed renewal, and recovery using a Stripe test clock",async()=>{
    const clock=await stripe.testHelpers.testClocks.create({frozen_time:Math.floor(Date.now()/1000),name:"Anonymous GitHub "+run});
    clocks.push(clock.id);
    const owner=new mongoose.Types.ObjectId().toString();
    const c=await stripe.customers.create({test_clock:clock.id,payment_method:"pm_card_visa",invoice_settings:{default_payment_method:"pm_card_visa"},metadata:{...metadata,owner}});
    customers.push(c.id);await BillingAccount.create({_id:owner,customerId:c.id});
    let sub=await stripe.subscriptions.create({customer:c.id,items:[{price:config.STRIPE_AUTHOR_MONTHLY_PRICE}],metadata:{...metadata,owner}});
    await syncSubscription(sub.id,stripe);
    const original=(await BillingGrant.findById(sub.id)).until.getTime();
    async function advance(time) {
      await stripe.testHelpers.testClocks.advance(clock.id,{frozen_time:time});
      for(let i=0;i<60;i++) {
        if((await stripe.testHelpers.testClocks.retrieve(clock.id)).status==="ready") return;
        await new Promise(r=>setTimeout(r,1000));
      }
      throw new Error("Test clock did not settle");
    }
    await advance(sub.items.data[0].current_period_end+1);
    sub=await stripe.subscriptions.retrieve(sub.id);
    let invoice=await stripe.invoices.retrieve(sub.latest_invoice);
    if(invoice.status==="draft") invoice=await stripe.invoices.finalizeInvoice(invoice.id);
    if(invoice.status==="open") await stripe.invoices.pay(invoice.id);
    await syncSubscription(sub.id,stripe);
    assert.ok((await BillingGrant.findById(sub.id)).until.getTime()>original);
    const paidThrough=(await BillingGrant.findById(sub.id)).until.getTime();
    const failed=await stripe.paymentMethods.attach("pm_card_chargeCustomerFail",{customer:c.id});
    await stripe.customers.update(c.id,{invoice_settings:{default_payment_method:failed.id}});
    await advance(sub.items.data[0].current_period_end+1);
    sub=await stripe.subscriptions.retrieve(sub.id);
    invoice=await stripe.invoices.retrieve(sub.latest_invoice);
    if(invoice.status==="draft") invoice=await stripe.invoices.finalizeInvoice(invoice.id);
    try { await stripe.invoices.pay(invoice.id); } catch(e) { assert.equal(e.type,"StripeCardError"); }
    await syncSubscription(sub.id,stripe);
    assert.equal((await BillingGrant.findById(sub.id)).until.getTime(),paidThrough);
    // App wall time does not follow Stripe's test clock. Verify paid-through does not advance.
    const good=await stripe.paymentMethods.attach("pm_card_visa",{customer:c.id});
    await stripe.customers.update(c.id,{invoice_settings:{default_payment_method:good.id}});
    await stripe.invoices.pay(invoice.id);
    await syncSubscription(sub.id,stripe);
    assert.ok((await BillingGrant.findById(sub.id)).until.getTime()>paidThrough);
  });
  await check("account deletion cancels subscription",async()=>{
    const c=await customer();
    const sub=await stripe.subscriptions.create({customer:c.id,items:[{price:config.STRIPE_AUTHOR_MONTHLY_PRICE}],metadata:{...metadata,owner:c.owner}});
    await syncSubscription(sub.id,stripe);
    await cancelAccountBilling(c.owner);
    assert.equal((await stripe.subscriptions.retrieve(sub.id)).status,"canceled");
  });
}
main().catch(e=>{console.error(JSON.stringify({failure:true,type:e.type||e.name,code:e.code,parameter:e.param,message:e.type?undefined:e.message}));process.exitCode=1;}).finally(async()=>{
  if(stripe) {
    for(const id of customers) try { await stripe.customers.del(id); } catch { console.error("Customer cleanup failed: "+id); }
    for(const id of clocks) try { await stripe.testHelpers.testClocks.del(id); } catch { console.error("Clock cleanup failed: "+id); }
    for(const id of prices) try { await stripe.prices.update(id,{active:false}); } catch { console.error("Price cleanup failed: "+id); }
    for(const id of products) try { await stripe.products.update(id,{active:false}); } catch { console.error("Product cleanup failed: "+id); }
  }
  if(mongoose.connection.readyState) await mongoose.disconnect();
  console.log(JSON.stringify({run,passed:results.length,results}));
});
