import type { HydratedDocument, Types } from "mongoose";
import { ScopedRepository } from "../../core/base/ScopedRepository.js";
import { AppError } from "../../core/errors/AppError.js";
import { isDuplicateKeyError } from "../../core/utils/mongo.js";
import type { ICommunity } from "../communities/community.model.js";
import type { IMember } from "../members/member.model.js";
import { ReportModel, reportMachine, type IReport, type ReportReason, type ReportTarget } from "./report.model.js";

type MemberDoc = HydratedDocument<IMember>;
type CommunityDoc = HydratedDocument<ICommunity>;

export class ReportRepository extends ScopedRepository<IReport> {
  constructor() {
    super(ReportModel);
  }

  openFor(communityId: Types.ObjectId, targetType: ReportTarget, targetId: string) {
    return this.findIn(communityId, { targetType, targetId, status: "open" } as never).exec();
  }

  /** Closes every open report on a target at once with one outcome. Returns how many were closed. */
  closeAll(
    communityId: Types.ObjectId,
    targetType: ReportTarget,
    targetId: string,
    to: "actioned" | "dismissed",
    by: Types.ObjectId,
  ) {
    return this.updateManyIn(
      communityId,
      { targetType, targetId, status: { $in: reportMachine.allowedFrom(to) } } as never,
      { status: to, resolvedBy: by, resolvedAt: new Date() } as never,
    );
  }

  grouped(communityId: Types.ObjectId, skip: number, limit: number) {
    return this.model
      .aggregate<{
        _id: { targetType: ReportTarget; targetId: string };
        count: number;
        reasons: ReportReason[];
        notes: string[];
        firstAt: Date;
      }>([
        { $match: { communityId, status: "open" } },
        {
          $group: {
            _id: { targetType: "$targetType", targetId: "$targetId" },
            count: { $sum: 1 },
            reasons: { $addToSet: "$reason" },
            notes: { $push: "$note" },
            firstAt: { $min: "$createdAt" },
          },
        },
        { $sort: { count: -1, firstAt: 1 } },
        { $skip: skip },
        { $limit: limit + 1 },
      ])
      .exec();
  }
}

/** Resolves a reported thing to an id in this community, or throws 404. Supplied by the composition root. */
export type ReportTargetResolver = (
  community: CommunityDoc,
  reporter: MemberDoc,
  rawId: string,
) => Promise<{ targetId: string; ownerId?: Types.ObjectId }>;

/** What a resolved report may do to its target. Supplied by the composition root. */
export interface ReportActions {
  /** Reporters reached the threshold: take the target out of view until a moderator decides. */
  hold(community: CommunityDoc, type: ReportTarget, targetId: string): Promise<void>;
  /** A moderator dismissed the reports: bring a held target back. */
  release(community: CommunityDoc, type: ReportTarget, targetId: string): Promise<void>;
  /** A moderator removed the target for the given reason. */
  remove(
    community: CommunityDoc,
    actor: MemberDoc,
    type: ReportTarget,
    targetId: string,
    reason: ReportReason,
  ): Promise<void>;
}

/** Distinct reporters that hide a post or comment until a moderator looks (TBD-13). */
export const AUTO_HIDE_THRESHOLD = 3;

export class ReportService {
  constructor(
    private readonly repository: ReportRepository,
    private readonly resolvers: Record<ReportTarget, ReportTargetResolver>,
    private readonly actions: ReportActions,
  ) {}

  async create(
    community: CommunityDoc,
    reporter: MemberDoc,
    input: { targetType: ReportTarget; targetId: string; reason: ReportReason; note?: string },
  ) {
    const target = await this.resolvers[input.targetType](community, reporter, input.targetId);
    if (target.ownerId?.equals(reporter._id)) throw AppError.badRequest("You cannot report your own content");

    try {
      await this.repository.createIn(community._id, {
        reporterId: reporter._id,
        targetType: input.targetType,
        targetId: target.targetId,
        reason: input.reason,
        note: input.note ?? "",
      });
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err; // already reported by this person: received, nothing new to do
      return { received: true, duplicate: true };
    }

    if (input.targetType === "post" || input.targetType === "comment") {
      const distinct = new Set(
        (await this.repository.openFor(community._id, input.targetType, target.targetId)).map((r) =>
          r.reporterId.toString(),
        ),
      );
      if (distinct.size >= AUTO_HIDE_THRESHOLD) await this.actions.hold(community, input.targetType, target.targetId);
    }
    return { received: true, duplicate: false };
  }

  /** Open reports grouped by target, worst first. Reporter identities are never included (FR-RPT-5). */
  async queue(community: CommunityDoc, page: number, limit: number) {
    const rows = await this.repository.grouped(community._id, (page - 1) * limit, limit);
    return {
      items: rows.slice(0, limit).map((r) => ({
        targetType: r._id.targetType,
        targetId: r._id.targetId,
        count: r.count,
        reasons: r.reasons,
        notes: r.notes.filter(Boolean).slice(0, 5),
        firstReportedAt: r.firstAt,
      })),
      hasMore: rows.length > limit,
    };
  }

  /** Closes all open reports on a target. `remove` also takes the content down for the most common reason. */
  async resolve(
    community: CommunityDoc,
    actor: MemberDoc,
    input: { targetType: ReportTarget; targetId: string; outcome: "actioned" | "dismissed"; remove?: boolean },
  ) {
    const open = await this.repository.openFor(community._id, input.targetType, input.targetId);
    if (open.length === 0) throw AppError.notFound("No open reports for this item");

    if (input.outcome === "actioned" && input.remove) {
      const counts = new Map<ReportReason, number>();
      for (const r of open) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
      const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      await this.actions.remove(community, actor, input.targetType, input.targetId, top);
    }
    if (input.outcome === "dismissed") await this.actions.release(community, input.targetType, input.targetId);
    return {
      closed: await this.repository.closeAll(community._id, input.targetType, input.targetId, input.outcome, actor._id),
    };
  }
}
