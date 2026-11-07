import type { CriterionId, CriterionResult, CriterionStatus, QualityGateConfig } from "../types.js";

export interface CriterionContext {
  config: QualityGateConfig;
}

interface Draft {
  id: CriterionId;
  label: string;
  status: CriterionStatus;
  score: number;
  blocking?: boolean;
  details: string[];
  evidence?: Record<string, unknown>;
}

export function build(config: QualityGateConfig, draft: Draft): CriterionResult {
  return {
    id: draft.id,
    label: draft.label,
    status: draft.status,
    score: draft.status === "skipped" ? 0 : clamp01(draft.score),
    weight: config.weights[draft.id],
    blocking: draft.status === "fail" && draft.blocking === true,
    details: draft.details,
    evidence: draft.evidence,
  };
}

export function skipped(
  config: QualityGateConfig,
  id: CriterionId,
  label: string,
  reason: string
): CriterionResult {
  return build(config, { id, label, status: "skipped", score: 0, details: [reason] });
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Rounded to two decimals so reports diff cleanly and read like a percentage. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
