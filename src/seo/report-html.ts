/**
 * The document a prospect actually opens.
 *
 * The visual language is the one already approved for the sales scan — navy on
 * off-white, printable to a PDF without reflowing. It is continued rather than
 * re-invented: this is the same artifact for the same audience, and a second
 * look would just be a second thing to approve. The copy is English; phrases
 * measured in the market keep their own direction through `dir="auto"`.
 *
 * Two rules run through every section. A section with no data is not rendered
 * at all, so the reader never meets a table of dashes. And a figure that was
 * calculated rather than measured says so on the page, next to the number.
 */

import type { CategoryDemand, ProspectReport } from "./report.js";

const esc = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] as string
  );

/** Numbers stay left-to-right when they land inside right-to-left text. */
const n = (value: number | null | undefined): string =>
  value === null || value === undefined
    ? "—"
    : `<span dir="ltr">${Math.round(value).toLocaleString("en-US")}</span>`;

const usd = (value: number | null | undefined, digits = 0): string =>
  value === null || value === undefined
    ? "—"
    : `<span dir="ltr">$${value.toLocaleString("en-US", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })}</span>`;

const reportDate = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });

/**
 * Sections number themselves as they are added.
 *
 * A section is dropped whenever its data is missing, so a fixed number would
 * leave the document running 05, 07 — which reads as a page gone missing.
 */
function section(counter: { value: number }, title: string, lead: string, body: string): string {
  const number = String(++counter.value).padStart(2, "0");
  return `<section class="mt-14 break-inside-avoid">
  <div class="flex items-baseline gap-3">
    <span class="font-mono text-xs font-bold tracking-[0.2em] text-muted-foreground">${number}</span>
    <div class="h-px flex-1 bg-border"></div>
  </div>
  <h2 class="mt-3 font-heading text-3xl font-bold text-primary">${esc(title)}</h2>
  ${lead ? `<p class="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">${lead}</p>` : ""}
  <div class="mt-6">${body}</div>
</section>`;
}

function stat(label: string, value: string, note = ""): string {
  return `<div class="rounded-lg border border-border bg-card p-5">
  <p class="text-xs font-semibold text-muted-foreground">${esc(label)}</p>
  <p class="mt-1 font-heading text-3xl font-bold text-foreground">${value}</p>
  ${note ? `<p class="mt-1 text-xs text-muted-foreground">${esc(note)}</p>` : ""}
</div>`;
}

function table(headers: string[], rows: string[][]): string {
  return `<div class="overflow-hidden rounded-lg border border-border bg-card">
  <table class="w-full text-sm">
    <thead><tr class="border-b border-border bg-muted/40">
      ${headers
        .map(
          (header, index) =>
            `<th class="px-4 py-2.5 text-xs font-bold text-muted-foreground ${index === 0 ? "text-left" : "text-right"}">${esc(header)}</th>`
        )
        .join("")}
    </tr></thead>
    <tbody>
      ${rows
        .map(
          (row) =>
            `<tr class="border-b border-border/50 last:border-0">${row
              .map(
                (cell, index) =>
                  `<td class="px-4 py-2.5 ${index === 0 ? "text-left" : "text-right font-mono text-xs"}">${cell}</td>`
              )
              .join("")}</tr>`
        )
        .join("")}
    </tbody>
  </table>
</div>`;
}

/**
 * The opening pair, and the reason the document exists.
 *
 * It states two measured facts side by side and performs no arithmetic between
 * them. An earlier version divided visits by category searches to show a
 * "market share", and on a strong domain it printed 2,791% — the two figures
 * have different scopes (all organic traffic against a sample of category
 * phrases), so the division was meaningless in both directions. On a weak
 * prospect it would have flattered them, which is worse.
 *
 * Two true numbers next to each other make the point without a ratio: this is
 * the demand, this is how much of the first page you hold.
 */
function headline(demand: CategoryDemand, firstPage: number | null): string {
  return `<div class="mt-10 grid gap-5 md:grid-cols-[1.2fr_1fr]">
  <div class="rounded-xl border border-primary/25 bg-primary/5 p-7">
    <p class="text-sm font-semibold text-primary">Searches in your category on Google</p>
    <p class="mt-2 font-heading text-6xl font-bold tracking-tight text-primary">${n(demand.monthlySearches)}</p>
    <p class="mt-2 text-sm text-muted-foreground">
      times a month, across ${n(demand.keywordCount)} phrases we measured around "${esc(demand.seed)}".
      ${
        demand.excluded.length > 0
          ? `This leaves out ${n(demand.excluded.length)} phrases from people looking for jobs or courses in the field, because they are not customers.`
          : ""
      }
    </p>
  </div>
  <div class="rounded-xl border border-border bg-card p-7">
    <p class="text-sm font-semibold text-foreground">You are on page one for</p>
    <p class="mt-2 font-heading text-6xl font-bold tracking-tight" style="color:${
      (firstPage ?? 0) > 0 ? "#3E7C59" : "#A84B4B"
    }">${n(firstPage)}</p>
    <p class="mt-2 text-sm text-muted-foreground">
      ${(firstPage ?? 0) > 0 ? "phrases, out of everything the site ranks for." : "phrases. Nobody is finding you in search."}
    </p>
  </div>
</div>`;
}

/** The whole document, as one self-contained file. */
export function renderProspectReport(report: ProspectReport): string {
  const parts: string[] = [];
  const counter = { value: 0 };

  if (report.categoryDemand) parts.push(headline(report.categoryDemand, report.visibility?.top10 ?? null));

  if (report.visibility) {
    const visibility = report.visibility;
    parts.push(
      section(
        counter,
        "Where you stand today",
        "Every number here was measured on Google on the date at the top of this page, not estimated.",
        `<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          ${stat("Phrases you appear for", n(visibility.organicKeywords))}
          ${stat("On page one", n(visibility.top10), `In the top three: ${visibility.top3 ?? 0}`)}
          ${stat("Monthly visits from search", n(visibility.organicTraffic))}
          ${stat("Value of this traffic", usd(visibility.organicTrafficCost), "At Google's cost per click")}
        </div>`
      )
    );
  }

  if (report.topKeywords.length > 0) {
    parts.push(
      section(
        counter,
        "What you appear for",
        "The phrases your site already ranks for, by the traffic they bring.",
        table(
          ["Phrase", "Position", "Monthly searches", "Estimated visits"],
          report.topKeywords
            .slice(0, 15)
            .map((row) => [
              `<span dir="auto">${esc(row.keyword)}</span>`,
              n(row.position),
              n(row.volume),
              n(row.trafficEstimate),
            ])
        )
      )
    );
  }

  if (report.demand.length > 0 && report.categoryDemand) {
    parts.push(
      section(
        counter,
        "What people search for in your category",
        "Real phrases with their monthly search volume. The list comes from Google data, not from guesswork.",
        table(
          ["Phrase", "Monthly searches", "Difficulty", "Cost per click"],
          report.demand
            .slice(0, 20)
            .map((row) => [
              `<span dir="auto">${esc(row.keyword)}</span>`,
              n(row.volume),
              row.difficulty === null ? "—" : `<span dir="ltr">${row.difficulty}</span>`,
              row.cpc === null ? "—" : usd(row.cpc, 2),
            ])
        )
      )
    );
  }

  // Who stands where the prospect is not. Placed straight after the demand,
  // because "here is the money" then "here is who is taking it" is the whole
  // argument, and it is the one pair that works on a prospect with no
  // rankings at all — which is most of them.
  if (report.serpOwners && report.serpOwners.owners.length > 0) {
    const owners = report.serpOwners;
    const measured = owners.keywords.length;
    parts.push(
      section(
        counter,
        "Who appears there instead of you",
        `We checked the results page for ${n(measured)} of the main phrases in your category. These are the companies that keep coming up, ` +
          `${
            owners.prospectAppearances === 0
              ? "and you do not appear for any of them."
              : `and you appear for ${n(owners.prospectAppearances)} of them.`
          }`,
        table(
          ["Site", "Phrases", "Best position"],
          owners.owners
            .slice(0, 10)
            .map((owner) => [
              `<span dir="ltr">${esc(owner.domain)}</span>`,
              `${n(owner.appearances)} of ${n(measured)}`,
              n(owner.bestPosition),
            ])
        )
      )
    );
  }

  if (report.themes.length > 0) {
    parts.push(
      section(
        counter,
        "The topics you are missing",
        "The same phrases, arranged by topic. Each row is a page or article your site should have, with the searches it would answer.",
        table(
          ["Topic", "Monthly searches", "Phrases in topic", "Example"],
          report.themes.map((theme) => [
            `<span dir="auto">${esc(theme.label)}</span>`,
            n(theme.monthlySearches),
            n(theme.keywords.length),
            `<span dir="auto">${esc(theme.keywords[0]?.keyword ?? "")}</span>`,
          ])
        )
      )
    );
  }

  if (report.gaps.length > 0 && report.opportunity) {
    const opportunity = report.opportunity;
    parts.push(
      section(
        counter,
        "What similar sites get and you do not",
        `Phrases a similar-sized competitor ranks for and you do not appear for at all. That is ${n(
          opportunity.missedMonthlySearches
        )} searches a month in total. In paid ads the same clicks would cost roughly ${usd(
          opportunity.missedMonthlyValueUsd
        )} a month — an estimate from the cost per click, not an invoice.`,
        table(
          ["Phrase", "Monthly searches", "Who appears there", "Their position"],
          report.gaps
            .slice(0, 20)
            .map((row) => [
              `<span dir="auto">${esc(row.keyword)}</span>`,
              n(row.volume),
              `<span dir="ltr">${esc(row.rival)}</span>`,
              n(row.theirPosition),
            ])
        )
      )
    );
  }

  if (report.crawl && report.crawl.pagesCrawled !== null) {
    const crawl = report.crawl;
    const lighthouse = crawl.lighthouse;

    const findings =
      crawl.findings.length > 0
        ? `<ul class="mt-5 space-y-2">${crawl.findings
            .map(
              (finding) =>
                `<li class="flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-3">
                  <span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style="background:#B66A3C"></span>
                  <span>
                    <span class="text-sm font-semibold text-foreground">${esc(finding.title)}</span>
                    <span class="block text-sm text-muted-foreground">${esc(finding.detail)}</span>
                  </span>
                </li>`
            )
            .join("")}</ul>`
        : `<p class="mt-4 text-sm text-muted-foreground">The crawl found no faults of the kind Google checks for.</p>`;

    parts.push(
      section(
        counter,
        "What Google sees when it crawls your site",
        `We crawled ${n(crawl.pagesCrawled)} pages of your site, using the same measures Google uses.`,
        `<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          ${stat("Pages crawled", n(crawl.pagesCrawled))}
          ${stat("Broken links", n(crawl.brokenLinks), "Lead to a page that does not exist")}
          ${stat("Pages without a description", n(crawl.pagesWithoutDescription), "The text shown in search results")}
          ${stat(
            "Average load time",
            crawl.averageLoadSeconds === null
              ? "—"
              : `<span dir="ltr">${crawl.averageLoadSeconds}s</span>`
          )}
        </div>
        ${
          lighthouse
            ? `<div class="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          ${stat("Speed score", n(lighthouse.performance), "Measured by Google, out of 100")}
          ${stat("Accessibility", n(lighthouse.accessibility))}
          ${stat("Best practices", n(lighthouse.bestPractices))}
          ${stat("SEO score", n(lighthouse.seo))}
        </div>`
            : ""
        }
        ${findings}`
      )
    );
  } else if (report.site) {
    const site = report.site;
    const findings =
      site.problems.length > 0
        ? `<ul class="mt-5 space-y-2">${site.problems
            .map(
              (problem) =>
                `<li class="flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm">
                  <span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style="background:#B66A3C"></span>
                  <span>${esc(problem)}</span>
                </li>`
            )
            .join("")}</ul>`
        : `<p class="mt-4 text-sm text-muted-foreground">The home page check found no technical faults of the kind Google checks for.</p>`;

    parts.push(
      section(
        counter,
        "What Google sees when it visits you",
        "A live check of your home page, using the same measures Google uses.",
        `<div class="grid gap-4 sm:grid-cols-3">
          ${stat("Load time", site.loadSeconds === null ? "—" : `<span dir="ltr">${site.loadSeconds}s</span>`)}
          ${stat("Title length", site.titleLength === null ? "—" : n(site.titleLength), "Google shows up to 60 characters")}
          ${stat("Internal links", n(site.internalLinks))}
        </div>
        ${findings}`
      )
    );
  }

  // The local half. Only reaches here when the profile was provably theirs —
  // the section refuses a near-miss rather than printing another company's
  // rating, which it once nearly did.
  if (report.local && report.local.profile.found) {
    const local = report.local;
    const profile = local.profile;
    const peerReviews = local.peerAverageReviews;

    const findings =
      local.findings.length > 0
        ? `<ul class="mt-5 space-y-2">${local.findings
            .map(
              (finding) =>
                `<li class="rounded-lg border border-border bg-card px-4 py-3">
                  <p class="text-sm font-semibold text-foreground">${esc(finding.title)}</p>
                  <p class="mt-1 text-sm text-muted-foreground">${esc(finding.detail)}</p>
                </li>`
            )
            .join("")}</ul>`
        : "";

    parts.push(
      section(
        counter,
        "Your Google business profile",
        "What a customer sees when they search for you by name or on Maps, next to other businesses in the same category.",
        `<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          ${stat("Rating", profile.rating === null ? "—" : `<span dir="ltr">${profile.rating}</span>`)}
          ${stat(
            "Reviews",
            n(profile.reviewCount),
            peerReviews === null ? "" : `Average for others in the category: ${Math.round(peerReviews)}`
          )}
          ${stat(
            "Rating for others",
            local.peerAverageRating === null
              ? "—"
              : `<span dir="ltr">${local.peerAverageRating.toFixed(1)}</span>`
          )}
          ${stat("Profile links to your site", profile.hasWebsite === true ? "Yes" : "No")}
        </div>
        ${findings}`
      )
    );
  }

  if (report.links) {
    const links = report.links;
    parts.push(
      section(
        counter,
        "Who links to you",
        "Links from other sites are one of the things Google counts. This is your picture today.",
        `<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          ${stat("Backlinks", n(links.backlinks))}
          ${stat("Linking sites", n(links.referringDomains))}
          ${stat("Broken backlinks", n(links.brokenBacklinks))}
          ${stat("Spam score", links.spamScore === null ? "—" : `<span dir="ltr">${links.spamScore}</span>`, "Lower is better")}
        </div>`
      )
    );
  }

  if (report.aiAnswers && report.aiAnswers.engines.length > 0) {
    const ai = report.aiAnswers;
    const named = ai.summary?.timesNamed ?? 0;
    const asked = ai.summary?.questionsAsked ?? ai.engines.length;
    // Domains only, never names lifted out of prose: a half-right competitor
    // name in a client's document is worse than no list.
    const instead = [...new Set(ai.engines.flatMap((entry) => entry.namedInstead))].slice(0, 12);

    parts.push(
      section(
        counter,
        "What AI assistants answer",
        `We asked an AI assistant ${n(asked)} questions a customer looking for a supplier in your field would ask. ` +
          (named === 0
            ? "You were not mentioned in any answer."
            : `You were mentioned in ${n(named)} of them.`),
        `${
          instead.length > 0
            ? `<p class="text-sm text-foreground">Mentioned instead of you:</p>
               <div class="mt-3 flex flex-wrap gap-2">${instead
                 .map(
                   (domain) =>
                     `<span dir="ltr" class="rounded-md border border-border bg-card px-2.5 py-1 font-mono text-xs">${esc(
                       domain
                     )}</span>`
                 )
                 .join("")}</div>`
            : ""
        }
        ${ai.engines
          .filter((entry) => entry.excerpt)
          .slice(0, 2)
          .map(
            (entry) =>
              `<div class="mt-5 rounded-lg border border-border bg-card p-4">
                <p class="text-xs font-semibold text-muted-foreground" dir="auto">${esc(entry.question)}</p>
                <p class="mt-2 text-sm leading-relaxed text-foreground" dir="auto">${esc(
                  entry.excerpt ?? ""
                )}</p>
              </div>`
          )
          .join("")}`
      )
    );
  }

  if (report.aiDemand.length > 0) {
    parts.push(
      section(
        counter,
        "What is happening in chat",
        "People now ask AI models as well. These are your phrases and how often they are asked there each month.",
        table(
          ["Phrase", "Monthly questions"],
          report.aiDemand
            .slice(0, 10)
            .map((row) => [`<span dir="auto">${esc(row.keyword)}</span>`, n(row.aiSearchVolume)])
        )
      )
    );
  }

  // The closing line says only what the document already showed, and says it
  // differently depending on which sections survived the audit.
  const gapLine = report.serpOwners && report.serpOwners.prospectAppearances === 0 && report.serpOwners.keywords.length > 0
    ? `We checked ${n(report.serpOwners.keywords.length)} main phrases in your category. You are not on page one for any of them.`
    : report.opportunity
    ? `There are ${n(report.opportunity.missedMonthlySearches)} searches a month on phrases where similar sites appear and you do not.`
    : report.visibility && (report.visibility.top10 ?? 0) === 0
      ? `The site ranks for ${n(report.visibility.organicKeywords)} phrases, and none of them is on page one.`
      : `The category we measured has ${n(report.categoryDemand?.monthlySearches ?? null)} searches a month.`;

  parts.push(
    `<section class="mt-16 rounded-xl border border-primary/25 bg-primary/5 p-8 break-inside-avoid">
      <h2 class="font-heading text-2xl font-bold text-primary">What this means</h2>
      <p class="mt-3 max-w-3xl text-sm leading-relaxed text-foreground">${gapLine}</p>
      <p class="mt-3 max-w-3xl text-sm leading-relaxed text-foreground">
        A campaign does not close this gap. Content that answers what people search for does, published
        steadily rather than once a quarter. That is what we do.
      </p>
    </section>`
  );

  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex, nofollow" />
<title>${esc(report.clientName)} — Search snapshot</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet" />
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
<style type="text/tailwindcss">
  @theme inline {
    --color-background: var(--background); --color-foreground: var(--foreground);
    --color-primary: var(--primary); --color-card: var(--card);
    --color-muted: var(--muted); --color-muted-foreground: var(--muted-foreground);
    --color-border: var(--border);
    --font-font-sans: var(--font-sans); --font-font-heading: var(--font-heading);
    --font-font-mono: var(--font-mono);
  }
  :root {
    --background:#F7F8FA; --foreground:#20252B; --primary:#173A5E; --card:#FFFFFF;
    --muted:#EEF1F5; --muted-foreground:#5C6674; --border:#DFE4EA;
    --font-sans:"Inter", system-ui, sans-serif;
    --font-heading:"Inter", system-ui, sans-serif;
    --font-mono:ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  @media print {
    .no-print { display: none !important; }
    body { background: #fff; }
  }
</style>
</head>
<body class="bg-background font-sans text-foreground antialiased">
<main class="mx-auto max-w-5xl px-5 py-12 md:px-8">
  <header class="border-b border-border pb-8">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <p class="font-mono text-xs font-bold tracking-[0.2em] text-muted-foreground">Search snapshot</p>
        <h1 class="mt-2 font-heading text-4xl font-bold tracking-tight text-primary md:text-5xl">${esc(report.clientName)}</h1>
        <p class="mt-2 font-mono text-sm text-muted-foreground" dir="ltr">${esc(report.domain)}</p>
      </div>
      <div class="text-right">
        <p class="text-xs text-muted-foreground">${esc(reportDate(report.generatedAt))}</p>
        <p class="mt-1 font-heading text-lg font-bold text-primary">Octypo</p>
        <button onclick="window.print()" class="no-print mt-3 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-muted">
          Save as file
        </button>
      </div>
    </div>
  </header>
  ${parts.join("\n")}
  <footer class="mt-16 border-t border-border pt-6 text-xs text-muted-foreground">
    The data was measured on Google on the date at the top of this page. Figures marked as estimates were calculated from the cost per click Google publishes.
  </footer>
</main>
</body>
</html>`;
}
