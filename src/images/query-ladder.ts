/**
 * Builds a ladder of search queries, most specific first.
 *
 * A single query built from the article's own words finds nothing about half
 * the time. Measured against real topics from the first prospect's content
 * plan, one query gave 50% coverage — and several of the "hits" matched on
 * words rather than subject (a classic car scored 0.60 against an article
 * about billboards).
 *
 * Stock libraries are indexed by what is visibly in the frame, not by what an
 * article is about. "LED screens for municipal and city events" is not a photo
 * anyone tagged; "city event crowd" is. So the ladder walks outward from the
 * exact subject to the visual scene that stands in for it, and stops at the
 * first rung that clears the relevance bar.
 *
 * The last rung is deliberately generic. A relevant-but-broad photograph beats
 * both an absurd one and no image at all — and every rung is still relevance-
 * checked, so a bad match is rejected regardless of which rung produced it.
 */

/**
 * Concrete, photographable scenes that stand in for an abstract business topic.
 *
 * Note the trailing wildcards: a bare `advertis` between word boundaries never
 * matches "advertising" — there is no boundary mid-word. That silently cost
 * every advertising article its stand-in scene.
 */
const SUBJECT_FALLBACKS: readonly (readonly [RegExp, string])[] = [
  [/\b(price|pricing|cost|budget|invoice|payment)\w*\b/i, "business calculator desk"],
  [/\b(choose|choosing|supplier|vendor|partner|compare)\b/i, "business meeting office"],
  [/\b(guide|how to|tutorial|steps|checklist)\b/i, "notebook planning desk"],
  [/\b(launch|opening|grand opening|new branch)\b/i, "storefront opening"],
  [/\b(municipal|city|council|public|government)\b/i, "city street architecture"],
  [/\b(event|festival|concert|conference|exhibition)\w*\b/i, "event crowd stage"],
  [/\b(retail|store|shop|shopping)\w*\b/i, "retail store interior"],
  [/\b(restaurant|food|cafe|dining|kitchen)\b/i, "restaurant interior"],
  [/\b(marketing|advertis\w*|campaign\w*|brand\w*)\b/i, "marketing team office"],
  [/\b(truck|vehicle|fleet|delivery|transport)\w*\b/i, "truck on the road"],
  [/\b(screen|display|digital signage|billboard)\w*\b/i, "digital billboard city"],
  [/\b(real estate|property|apartment|rental)\b/i, "modern building exterior"],
  [/\b(legal|law|contract|compliance)\b/i, "documents signing desk"],
  [/\b(health|clinic|dental|medical)\b/i, "modern clinic interior"],
];

/**
 * Deliberately NOT a universal fallback. Measurement showed a generic rung
 * "succeeding" with a laptop on a desk for an article about LED advertising
 * trucks — technically an image, visibly unrelated, and worse for the customer
 * than the blank space it filled. If the ladder cannot find something connected
 * to the subject, generation or no image is the honest outcome.
 */

const NOISE = new Set([
  "the", "and", "for", "with", "your", "how", "what", "why", "when", "where",
  "complete", "guide", "best", "top", "ultimate", "everything", "about", "much",
  "does", "from", "that", "this", "into", "over", "you", "our", "are", "can",
  "versus", "vs", "using", "make", "made", "need", "needs", "should",
]);

function words(text: string): string[] {
  return text
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 2 && !NOISE.has(w.toLowerCase()));
}

export function buildQueryLadder(topic: string, keywords: readonly string[] = []): string[] {
  const ladder: string[] = [];
  const push = (q: string) => {
    const clean = q.trim();
    if (clean && !ladder.includes(clean)) ladder.push(clean);
  };

  // 1. The keyword the article targets — the most specific thing we know.
  const primary = keywords.filter(Boolean)[0]?.trim();
  if (primary) push(primary);

  // 2. The strongest nouns from the title, capped at three: longer queries
  //    narrow stock results to nothing.
  const titleWords = words(topic);
  if (titleWords.length) push(titleWords.slice(0, 3).join(" "));

  // 3. Two words is where stock libraries actually have depth.
  if (titleWords.length > 1) push(titleWords.slice(0, 2).join(" "));

  // 4. A concrete scene standing in for the subject.
  const haystack = `${topic} ${keywords.join(" ")}`;
  for (const [pattern, scene] of SUBJECT_FALLBACKS) {
    if (pattern.test(haystack)) {
      push(scene);
      break;
    }
  }

  return ladder;
}

export { SUBJECT_FALLBACKS };
