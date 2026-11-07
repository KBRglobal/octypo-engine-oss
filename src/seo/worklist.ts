/**
 * The other half of a report: what to actually do about it.
 *
 * The document is for the prospect and says what is true. This is for whoever
 * does the work — a person or an agent handed the file — and says what to
 * change, in what order, with the evidence attached to each item so nobody
 * has to re-open the report to know why a task exists.
 *
 * It is never shown to the client. That separation is the point: the document
 * has to be careful and flattering-free, while this can be blunt, list an
 * exact file to open, and admit that an item is a guess.
 *
 * Nothing is invented here. Every task is derived from a measurement already
 * in the report, and a report that measured nothing produces an empty list
 * rather than generic advice — generic advice is what makes a work plan
 * worthless, because it would be the same for every client.
 */

import type { ProspectReport } from "./report.js";

export type WorkArea = "site" | "content" | "profile" | "visibility";

export interface WorkTask {
  id: string;
  area: WorkArea;
  title: string;
  /** What to change, concretely. */
  what: string;
  /** Why it matters, in numbers that came from the report. */
  why: string;
  /** How big the job is, so a list can be split across a week. */
  effort: "small" | "medium" | "large";
  /** The measurement behind the task, for anyone who wants to check it. */
  evidence: string[];
  /** Monthly searches this task is about, when the task is about demand. */
  monthlySearches?: number;
}

export interface Worklist {
  domain: string;
  clientName: string;
  generatedAt: string;
  tasks: WorkTask[];
  /** Sections the report could not measure — gaps in the plan, named. */
  notMeasured: string[];
  /** Real searches in the trade that are not customers, and why. */
  excluded: { keyword: string; reason: "employment" | "study" }[];
}

const AREA_ORDER: Record<WorkArea, number> = { site: 0, content: 1, profile: 2, visibility: 3 };

/**
 * Turn a report into an ordered list of jobs.
 *
 * Site fixes come first because they are cheap, certain and block everything
 * else: there is no point writing for a category while the pages that would
 * carry it are unreadable. Content follows, ordered by the demand behind it,
 * so the biggest theme is the first thing written.
 */
export function buildWorklist(report: ProspectReport): Worklist {
  const tasks: WorkTask[] = [];
  const add = (task: WorkTask) => tasks.push(task);

  // ── The site itself ───────────────────────────────────────────────────────
  const crawl = report.crawl;
  if (crawl) {
    if ((crawl.imagesWithoutAlt ?? 0) > 0) {
      // Phrased as a check, not a fault. An empty alt is correct for a
      // decorative image, and on the first site this ran against all forty
      // were exactly that. Only a person can tell the difference.
      add({
        id: "site-image-alt",
        area: "site",
        title: "Review images without alt text",
        what: `${crawl.imagesWithoutAlt} images have no alt text. Go through them and describe only the ones that carry information — a background image, a logo with its name written beside it, or an image inside a link that already has a name should stay without.`,
        why: "An informative image with no description stays out of image search and is not read by screen readers. A decorative image, on the other hand, should stay empty.",
        effort: (crawl.imagesWithoutAlt ?? 0) > 30 ? "medium" : "small",
        evidence: [`${crawl.imagesWithoutAlt} images in a crawl of ${crawl.pagesCrawled} pages`],
      });
    }
    if ((crawl.pagesWithoutDescription ?? 0) > 0) {
      add({
        id: "site-meta-description",
        area: "site",
        title: "Add search result descriptions",
        what: `Write a description for the ${crawl.pagesWithoutDescription} pages that have none.`,
        why: "Without a description, Google picks for itself which sentence of the page to show.",
        effort: "medium",
        evidence: [`${crawl.pagesWithoutDescription} pages without a description`],
      });
    }
    if ((crawl.brokenLinks ?? 0) > 0) {
      add({
        id: "site-broken-links",
        area: "site",
        title: "Broken links",
        what: `Fix ${crawl.brokenLinks} links that lead to a page that does not exist.`,
        why: "A visitor who lands on an error page goes back to Google, and Google counts that.",
        effort: "small",
        evidence: [`${crawl.brokenLinks} broken links, not counting system links`],
      });
    }
    if ((crawl.slowPages ?? 0) > 0) {
      add({
        id: "site-slow-pages",
        area: "site",
        title: "Slow pages",
        what: `Speed up ${crawl.slowPages} pages that take more than three seconds to load.`,
        why: "Speed is a stated Google ranking factor, and a slow page loses visitors before it opens.",
        effort: "medium",
        evidence: [`${crawl.slowPages} pages over three seconds`],
      });
    }
    if ((crawl.pagesWithoutH1 ?? 0) > 0) {
      add({
        id: "site-h1",
        area: "site",
        title: "Missing main heading",
        what: `Add a main heading to ${crawl.pagesWithoutH1} pages.`,
        why: "The main heading is what tells Google what the page is about.",
        effort: "small",
        evidence: [`${crawl.pagesWithoutH1} pages without a main heading`],
      });
    }
  }

  // ── The content to write ─────────────────────────────────────────────────
  for (const theme of report.themes) {
    add({
      id: `content-${theme.label}`,
      area: "content",
      title: `Page on "${theme.label}"`,
      what: `Write a page or article that answers the ${theme.keywords.length} phrases in this topic. Start with "${theme.keywords[0]?.keyword ?? ""}".`,
      why: `${theme.monthlySearches.toLocaleString("en-US")} searches a month on this topic, and you have no page for it.`,
      effort: theme.keywords.length > 6 ? "large" : "medium",
      evidence: theme.keywords
        .slice(0, 6)
        .map((row) => `${row.keyword} — ${row.volume ?? "?"} searches a month`),
      monthlySearches: theme.monthlySearches,
    });
  }

  // ── Their Google profile ─────────────────────────────────────────────────
  if (report.local?.profile.found) {
    for (const finding of report.local.findings) {
      add({
        id: `profile-${finding.title}`,
        area: "profile",
        title: finding.title,
        what: finding.detail,
        why: "The Google profile is the first thing a customer sees when they search for you by name.",
        effort: "small",
        evidence: finding.count === null ? [] : [`${finding.count}`],
      });
    }
  }

  // ── Where they stand ─────────────────────────────────────────────────────
  const owners = report.serpOwners;
  if (owners && owners.keywords.length > 0 && owners.prospectAppearances === 0) {
    add({
      id: "visibility-page-one",
      area: "visibility",
      title: "Not a single phrase on page one",
      what: "Once the content above is live, track positions and deepen the pages that get close to page one.",
      why: `${owners.keywords.length} main phrases were checked. The site is not on page one for any of them.`,
      effort: "large",
      evidence: owners.owners
        .slice(0, 5)
        .map((owner) => `${owner.domain} — appears for ${owner.appearances} of them, highest at position ${owner.bestPosition}`),
    });
  }

  if (report.aiAnswers && (report.aiAnswers.summary?.timesNamed ?? 0) === 0 && report.aiAnswers.engines.length > 0) {
    const instead = [...new Set(report.aiAnswers.engines.flatMap((entry) => entry.namedInstead))];
    add({
      id: "visibility-ai",
      area: "visibility",
      title: "AI assistants do not mention you",
      what: "Get mentioned in the sources the assistants cite: guides, directories and comparison sites in your field.",
      why: `${report.aiAnswers.summary?.questionsAsked ?? 0} questions were asked. The business was not mentioned in any answer.`,
      effort: "large",
      evidence: instead.slice(0, 8).map((domain) => `Mentioned instead of you: ${domain}`),
    });
  }

  tasks.sort((a, b) => {
    const byArea = AREA_ORDER[a.area] - AREA_ORDER[b.area];
    if (byArea !== 0) return byArea;
    return (b.monthlySearches ?? 0) - (a.monthlySearches ?? 0);
  });

  return {
    domain: report.domain,
    clientName: report.clientName,
    generatedAt: report.generatedAt,
    tasks,
    notMeasured: report.omitted,
    excluded: report.categoryDemand?.excluded ?? [],
  };
}

const AREA_TITLES: Record<WorkArea, string> = {
  site: "The site",
  content: "Content to write",
  profile: "Google profile",
  visibility: "Visibility",
};

/**
 * The same list as Markdown, which is the form a person reads and an agent
 * can be handed directly. Checkboxes because the file is meant to be worked
 * through and edited, not filed.
 */
export function renderWorklistMarkdown(worklist: Worklist): string {
  const lines: string[] = [
    `# ${worklist.clientName} — Work list`,
    "",
    `Site: ${worklist.domain}`,
    `Created: ${new Date(worklist.generatedAt).toLocaleDateString("en-US")}`,
    `Tasks: ${worklist.tasks.length}`,
    "",
    "> Internal file. Not sent to the client.",
    "",
  ];

  for (const area of ["site", "content", "profile", "visibility"] as WorkArea[]) {
    const inArea = worklist.tasks.filter((task) => task.area === area);
    if (inArea.length === 0) continue;

    lines.push(`## ${AREA_TITLES[area]}`, "");
    for (const task of inArea) {
      lines.push(`- [ ] **${task.title}** \`${task.effort}\``);
      lines.push(`  - ${task.what}`);
      lines.push(`  - Why: ${task.why}`);
      for (const item of task.evidence) lines.push(`  - ${item}`);
      lines.push("");
    }
  }

  if (worklist.excluded.length > 0) {
    lines.push(
      "## Not counted as demand",
      "",
      "Real searches in the field that were left out of the count, because they are not customers:",
      "",
      ...worklist.excluded.map(
        (row) => `- ${row.keyword} — ${row.reason === "employment" ? "looking for a job" : "looking to study"}`
      ),
      ""
    );
  }

  if (worklist.notMeasured.length > 0) {
    lines.push(
      "## Not measured",
      "",
      "These parts did not make it into the report, so there are no tasks for them:",
      "",
      ...worklist.notMeasured.map((name) => `- ${name}`),
      ""
    );
  }

  return lines.join("\n");
}
