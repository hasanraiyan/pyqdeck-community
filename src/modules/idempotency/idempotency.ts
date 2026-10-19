import { Schema, model, type Types } from "mongoose";
import { isDuplicateKeyError } from "../../core/utils/mongo.js";

const RETENTION_SECONDS = 24 * 60 * 60;

interface IIdempotencyRecord {
  communityId: Types.ObjectId;
  memberId: Types.ObjectId;
  scope: string;
  key: string;
  resourceId: Types.ObjectId;
  createdAt: Date;
}

const schema = new Schema<IIdempotencyRecord>({
  communityId: { type: Schema.Types.ObjectId, required: true },
  memberId: { type: Schema.Types.ObjectId, required: true },
  scope: { type: String, required: true },
  key: { type: String, required: true, maxlength: 100 },
  resourceId: { type: Schema.Types.ObjectId, required: true },
  createdAt: { type: Date, default: Date.now, expires: RETENTION_SECONDS },
});
schema.index({ communityId: 1, memberId: 1, scope: 1, key: 1 }, { unique: true });

const IdempotencyModel = model<IIdempotencyRecord>("IdempotencyRecord", schema);

type Id = string | Types.ObjectId;

/**
 * Makes a retried create harmless (NFR-USE-3): the app sends the same `Idempotency-Key` after a timeout and gets the
 * original resource back instead of a duplicate. Keys live for 24 hours.
 */
export class IdempotencyStore {
  async find(communityId: Id, memberId: Id, scope: string, key: string): Promise<Types.ObjectId | null> {
    const row = await IdempotencyModel.findOne({ communityId, memberId, scope, key }).lean().exec();
    return row?.resourceId ?? null;
  }

  async remember(communityId: Id, memberId: Id, scope: string, key: string, resourceId: Id) {
    try {
      await IdempotencyModel.create({ communityId, memberId, scope, key, resourceId });
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err; // a parallel retry recorded it first: same outcome
    }
  }
}

export const idempotencyKeyFrom = (header: string | undefined) => {
  const key = header?.trim();
  return key && key.length <= 100 ? key : undefined;
};
