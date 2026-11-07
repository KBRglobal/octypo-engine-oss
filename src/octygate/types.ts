export type OctyGateRule = "intent" | "capsule" | "truth" | "links" | "duplicates" | "technical";

export interface LivePage {
  url: string;
  path: string;
  status: number;
  title: string;
  h1: string;
  opening: string;
  text: string;
  canonical: string;
  noindex: boolean;
  internalLinks: string[];
  externalLinks: string[];
  faqQuestions: string[];
}

export interface OctyGateIncident {
  id: string;
  rule: OctyGateRule;
  status: "emergency";
  url: string;
  message: string;
  evidence: Record<string, unknown>;
  repair: string;
}

export interface OctyGateReport {
  runId: string;
  siteUrl: string;
  startedAt: string;
  completedAt: string;
  pagesChecked: number;
  incidents: OctyGateIncident[];
  clean: boolean;
}
