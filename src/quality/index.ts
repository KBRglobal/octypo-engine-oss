export { scoreArticle, formatQualityReport } from "./score-article.js";
export { DEFAULT_QUALITY_GATE_CONFIG, loadQualityGateConfig } from "./config.js";
export {
  applyQualityGate,
  qualityCorrections,
  qualityEditorNote,
  qualityInputFromApproval,
  qualityIssues,
  type ArticleQualityContext,
} from "./gate.js";
export type {
  ArticleQualityInput,
  ArticleQualityReport,
  CriterionId,
  CriterionResult,
  CriterionStatus,
  QualityGateConfig,
} from "./types.js";
