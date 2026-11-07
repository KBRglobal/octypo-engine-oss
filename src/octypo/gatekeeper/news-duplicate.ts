/**
 * Has the engine already written this news story?
 *
 * Feeds report one development many times: the same route suspension can come
 * in from three outlets within two days, and without this check the engine
 * writes it three times. Google treats the copies as one query split three
 * ways, and the scaled-content policy names exactly this pattern.
 *
 * A new feed item is a duplicate of a story written in the last 21 days when
 * both of these hold:
 *
 *   entities  they share one named subject (a concept) or at least two
 *             distinctive words; a weak concept (a venue) counts as one word
 *
 * A ban is a subject, not a development: "the direct-flights ban was
 * extended" and "... was lifted" are two stories.
 *   event     they describe the same kind of development (suspension,
 *             opening, show, extension ...)
 *
 * With no event word on the new headline, only a heavy overlap counts: three
 * or more shared words covering at least 75% of the smaller side. Everything
 * else is let through: a missed duplicate is one weak article, a false match
 * is a lost scoop. The same event on different entities (another comedian at
 * the same venue) and a different event on the same entity ("the airline
 * resumes") are not duplicates.
 *
 * The event vocabulary is English. A headline in any other language has no
 * event word, so it takes the heavy-overlap rule, which needs no vocabulary
 * and works on any script. That rule is the stricter of the two, so a language
 * without a list can only miss a duplicate, never hold a good story.
 *
 * Headlines only: summaries mention too much to be evidence of the story.
 * A past story carries every headline it is known by (the feed title, same
 * language as the new item, plus the article title, slug and keyword), so an
 * English feed item still meets a non-English article through its English slug.
 */

import {
  ENTITY_CONCEPTS,
  buildGenericSet,
  contentTerms,
  frequentTokens,
  sharedTerms,
  tokenForms,
  normaliseText,
  type Concept,
  type Term,
} from "../../lib/topic-terms.js";

export const NEWS_DUPLICATE_WINDOW_DAYS = 21;

export interface PastStory {
  /** rss_feed_items.id when the story came from a feed. */
  feedItemId?: string | null;
  feedTitle?: string | null;
  title?: string | null;
  slug?: string | null;
  primaryKeyword?: string | null;
  url?: string | null;
  at?: Date | string | null;
}

export interface NewsDuplicate {
  story: PastStory;
  sharedEntities: string[];
  sharedEvents: string[];
  reason: string;
}

/**
 * Word stems per kind of development, matched on the start of any token form;
 * "=" marks a whole word ("=ban" must not match "bank").
 */
const EVENT_STEMS: Record<string, string[]> = {
  halt: ["suspend", "suspension", "cancel", "halt", "paus", "grounded", "axed", "scrap"],
  close: ["close", "closes", "closed", "closing", "=shut", "shuts", "shutdown"],
  open: ["open", "reopen", "launch", "debut", "unveil", "inaugurat"],
  resume: ["resum", "restart", "restor"],
  extend: ["extend", "extension", "prolong"],
  show: ["=show", "=shows", "perform", "concert", "=tour", "=tours", "=gig", "=gigs", "standup", "comed"],
  sale: ["ticket", "=sale", "=sales"],
};

function eventsOfForms(forms: string[]): string[] {
  const out: string[] = [];
  for (const [event, stems] of Object.entries(EVENT_STEMS)) {
    const hit = forms.some((form) =>
      stems.some((stem) => (stem.startsWith("=") ? form === stem.slice(1) : form.startsWith(normaliseText(stem))))
    );
    if (hit) {
      out.push(event);
    }
  }
  return out;
}

export function eventsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const token of normaliseText(text).split(" ")) {
    if (token.length < 3) continue;
    for (const event of eventsOfForms(tokenForms(token))) out.add(event);
  }
  return out;
}

function isEventToken(forms: string[]): boolean {
  return eventsOfForms(forms).length > 0;
}

/** A slug reads as words: "harbor-air-route-suspended-november". */
function slugWords(slug: string | null | undefined): string {
  return (slug ?? "").replace(/[-_/]+/g, " ");
}

export function storyHeadlines(story: PastStory): string[] {
  return [story.feedTitle, story.title, slugWords(story.slug), story.primaryKeyword].filter(
    (text): text is string => Boolean(text && text.trim())
  );
}

interface PreparedStory {
  story: PastStory;
  entities: Term[];
  events: Set<string>;
}

export interface NewsIndex {
  stories: PreparedStory[];
  generic: Set<string>;
  concepts: Concept[];
}

/**
 * Prepare the recent stories once per pipeline run.
 *
 * `genericTerms` adds the site's own low-information words (its city). They
 * are also learnt from the corpus: a word in more than 30% of recent
 * headlines names the site, not a story, in whatever language it is written.
 * `concepts` adds the names a site spells more than one way.
 */
export function buildNewsIndex(
  stories: PastStory[],
  genericTerms: string[] = [],
  concepts: Concept[] = ENTITY_CONCEPTS
): NewsIndex {
  const headlines = stories.map((story) => storyHeadlines(story).join(" "));
  const generic = buildGenericSet([...genericTerms, ...frequentTokens(headlines, 0.3, 8)]);
  const index: NewsIndex = { stories: [], generic, concepts };
  index.stories = stories.map((story) => prepare(story, index));
  return index;
}

function prepare(story: PastStory, index: NewsIndex): PreparedStory {
  const text = storyHeadlines(story).join(" \n ");
  return {
    story,
    entities: entityTerms(text, index),
    events: eventsOf(text),
  };
}

function entityTerms(text: string, { generic, concepts }: NewsIndex): Term[] {
  // Line by line, so a concept cannot be stitched across two headlines.
  const terms: Term[] = [];
  for (const line of text.split("\n")) {
    for (const term of contentTerms(line, { concepts, generic, exclude: isEventToken })) {
      if (!terms.some((existing) => existing.raw === term.raw)) terms.push(term);
    }
  }
  return terms;
}

/** Add a story approved during this run, so two feeds in one cycle do not both pass. */
export function addStory(index: NewsIndex, story: PastStory): void {
  index.stories.push(prepare(story, index));
}

function withinWindow(at: PastStory["at"], now: Date, days: number): boolean {
  if (!at) return true; // the caller's query already bounded it
  const time = new Date(at).getTime();
  if (Number.isNaN(time)) return true;
  return now.getTime() - time <= days * 24 * 60 * 60 * 1000;
}

export function findNewsDuplicate(
  item: { id?: string | null; title: string; url?: string | null },
  index: NewsIndex,
  options: { now?: Date; windowDays?: number } = {}
): NewsDuplicate | null {
  const { now = new Date(), windowDays = NEWS_DUPLICATE_WINDOW_DAYS } = options;
  const entities = entityTerms(item.title, index);
  const events = eventsOf(item.title);
  if (entities.length === 0) return null;

  let best: (NewsDuplicate & { score: number }) | null = null;
  for (const prepared of index.stories) {
    if (item.id && prepared.story.feedItemId === item.id) continue;
    if (!withinWindow(prepared.story.at, now, windowDays)) continue;

    const shared = sharedTerms(entities, prepared.entities);
    const conceptShared = shared.some((term) => term.concept && !term.weak);
    const entityMatch = conceptShared || shared.length >= 2;
    if (!entityMatch) continue;

    const sharedEvents = [...events].filter((event) => prepared.events.has(event));
    let reason: string;
    if (sharedEvents.length > 0) {
      reason = "same entities, same event";
    } else if (events.size === 0) {
      const smaller = Math.min(entities.length, prepared.entities.length);
      if (!(shared.length >= 3 && shared.length / smaller >= 0.75)) continue;
      reason = "same entities, headline overlap";
    } else {
      continue; // same entities, a different development
    }

    const score = shared.length + sharedEvents.length;
    if (!best || score > best.score) {
      best = {
        story: prepared.story,
        sharedEntities: shared.map((term) => term.raw),
        sharedEvents,
        reason,
        score,
      };
    }
  }
  if (!best) return null;
  const { score: _score, ...duplicate } = best;
  return duplicate;
}
