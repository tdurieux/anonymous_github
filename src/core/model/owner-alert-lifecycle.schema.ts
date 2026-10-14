import { randomUUID } from "crypto";
import { Document, Query, Schema, Types, mongo } from "mongoose";

const inactive = new Set(["archived", "expired", "expiring", "removed", "removing"]);
type Owner = { _id: Types.ObjectId; accessAlertResetRevision?: number; accessAlertDeactivations?: string[] };
type Fence = { users: mongo.Collection<Owner>; owners: Types.ObjectId[]; token: string };

/** Lifecycle mutations and email dispatch compete on the owner document. */
export function ownerAlertLifecycle(schema: Schema): void {
  const fences = new WeakMap<object, Fence>();
  const begin = async (operation: object, db: { collection(name: string): unknown }, owners: Types.ObjectId[]) => {
    if (!owners.length) return;
    const users = db.collection("users") as mongo.Collection<Owner>;
    const token = randomUUID();
    // Do not expire this reservation: an interrupted database mutation may still
    // commit. Offline reconciliation can clear it after all writers have stopped.
    await users.updateMany({ _id: { $in: owners } }, {
      $inc: { accessAlertResetRevision: 1 }, $addToSet: { accessAlertDeactivations: token },
    });
    fences.set(operation, { users, owners, token });
  };
  const finish = async (operation: object) => {
    const fence = fences.get(operation);
    if (!fence) return;
    await fence.users.updateMany({ _id: { $in: fence.owners } }, { $pull: { accessAlertDeactivations: fence.token } });
    fences.delete(operation);
  };
  schema.pre(["updateOne", "updateMany", "findOneAndUpdate"], async function (this: Query<unknown, unknown>) {
    const update = this.getUpdate();
    if (!update) return;
    const stages = (Array.isArray(update) ? update : [update]) as { $set?: { status?: unknown }; status?: unknown }[];
    if (!stages.some(stage => { const status = stage.$set?.status ?? stage.status; return typeof status === "string" && inactive.has(status); })) return;
    const filter = this.getFilter();
    const lookup = this.model.distinct("owner", filter);
    const collation = this.getOptions().collation;
    if (collation) lookup.collation(collation);
    const owners = (await lookup.exec()).filter(id => id && Types.ObjectId.isValid(id));
    await begin(this, this.model.db, owners);
    // Preserve the owner snapshot: reassignment must not move this mutation to
    // an account whose dispatch fence was not advanced.
    this.setQuery({ $and: [filter, { $or: [{ owner: { $in: owners } }, { owner: null }] }] });
  });
  schema.post(["updateOne", "updateMany", "findOneAndUpdate"], async function () { await finish(this); });
  schema.pre("save", async function (this: Document & { status?: string; owner?: Types.ObjectId; $where?: Record<string, unknown> }) {
    if (!inactive.has(this.status || "") || !this.isModified("status")) return;
    const current = this.isNew ? null : await this.collection.findOne({ _id: this._id }, { projection: { owner: 1 } });
    const owners = [current?.owner, this.owner].filter((id): id is Types.ObjectId => Boolean(id && Types.ObjectId.isValid(id)));
    await begin(this, this.db, owners);
    if (current) this.$where = { $and: [this.$where || {}, { owner: current.owner ?? null }] };
  });
  schema.post("save", async function () { await finish(this); });
  // Failed or ambiguous mutations retain their reservation. Releasing one here
  // could permit dispatch while the resource write subsequently completes.
}
