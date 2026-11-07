/**
 * Topic configuration — replaces hardcoded keyword maps.
 *
 * Topics are how the engine groups and tags content. Each topic has a slug,
 * a display name and a list of keywords used for matching feed items and
 * articles to topics.
 *
 * Add your own topics here (or load them from your own source).
 */

export interface Topic {
  slug: string;
  name: string;
  keywords: string[];
}

function loadTopicsFromEnv(): Topic[] {
  const raw = process.env.TOPICS_JSON?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is Topic =>
        t && typeof t.slug === "string" && typeof t.name === "string" && Array.isArray(t.keywords),
    );
  } catch {
    console.error("[topics] TOPICS_JSON is not valid JSON — running with no topics");
    return [];
  }
}

// Configure via the TOPICS_JSON env var, e.g.:
// TOPICS_JSON='[{"slug":"ai","name":"Artificial Intelligence","keywords":["ai","machine learning","llm"]}]'
export const topics: Topic[] = loadTopicsFromEnv();

/**
 * Match a text against the topic keyword map and return matching topic slugs.
 * Returns the first (most specific) match, or an empty array if none.
 * Same contract as the legacy keyword matcher.
 */
export function matchTopics(text: string): string[] {
  const lower = ` ${text.toLowerCase()} `;
  const matched: string[] = [];

  for (const topic of topics) {
    for (const kw of topic.keywords) {
      if (lower.includes(kw.toLowerCase())) {
        if (!matched.includes(topic.slug)) {
          matched.push(topic.slug);
        }
        break;
      }
    }
  }

  return matched.length > 0 ? [matched[0]] : [];
}

/**
 * Detect a single topic slug from title + description, or null when no match.
 */
export function detectTopicFromContent(title: string, description: string): string | null {
  const matches = matchTopics(`${title} ${description}`);
  return matches.length > 0 ? matches[0] : null;
}
