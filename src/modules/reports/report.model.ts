import { Schema, model, type Types } from "mongoose";
import { defineMachine } from "../../core/state/state-machine.js";

export const REPORT_TARGETS = ["post", "comment", "member", "link"] as const;
export const REPORT_REASONS = ["spam", "harassment", "hate", "sexual", "violence", "misinformation", "other"] as const;
export const REPORT_STATUSES = ["open", "actioned", "dismissed"] as const;
export type ReportTarget = (typeof REPORT_TARGETS)[number];
export type ReportReason = (typeof REPORT_REASONS)[number];
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const reportMachine = defineMachine<ReportStatus>("Report", {
  open: ["actioned", "dismissed"],
  actioned: [],
  dismissed: [],
});

export interface IReport {
  communityId: Types.ObjectId;
  reporterId: Types.ObjectId;
  targetType: ReportTarget;
  /** Post, comment or member id, or a link code. */
  targetId: string;
  reason: ReportReason;
  note: string;
  status: ReportStatus;
  resolvedBy?: Types.ObjectId;
  resolvedAt?: Date;
  createdAt?: Date;
}

const reportSchema = new Schema<IReport>(
  {
    communityId: { type: Schema.Types.ObjectId, ref: "Community", required: true },
    reporterId: { type: Schema.Types.ObjectId, ref: "Member", required: true },
    targetType: { type: String, enum: REPORT_TARGETS, required: true },
    targetId: { type: String, required: true },
    reason: { type: String, enum: REPORT_REASONS, required: true },
    note: { type: String, default: "", maxlength: 300 },
    status: { type: String, enum: REPORT_STATUSES, default: "open", required: true },
    resolvedBy: { type: Schema.Types.ObjectId, ref: "Member" },
    resolvedAt: Date,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// One open report per reporter and target (FR-RPT-2); a closed one does not block a new report.
reportSchema.index(
  { communityId: 1, reporterId: 1, targetType: 1, targetId: 1 },
  { unique: true, partialFilterExpression: { status: "open" } },
);
reportSchema.index({ communityId: 1, status: 1, targetType: 1, targetId: 1 });

export const ReportModel = model<IReport>("Report", reportSchema);
