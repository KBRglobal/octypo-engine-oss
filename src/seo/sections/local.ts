/**
 * The local half of the prospect report: what a person sees on Google Maps.
 *
 * For a small business the organic half of the report is often thin — five
 * ranked keywords and no backlinks — while the thing that actually feeds it is
 * the Google profile: the rating, the review count, whether anyone ever answers
 * a review. That half is measurable, and unlike a ranking estimate it is a
 * reading rather than a model: Google says 4.4 from 5,259 votes, and so do we.
 *
 * The house rules from `report.ts` hold here without exception. A missing
 * number stays null and is never rendered as zero, because on this page a zero
 * is an accusation ("you have no reviews") and a null is the truth ("we could
 * not see"). The one distinction worth the whole section is between a business
 * with an empty profile and a business with no profile at all — the second is
 * the strongest finding a local report can carry, and collapsing it into zeros
 * would throw it away.
 */

import { logger } from "../../lib/logger.js";
import { SeoApiError, type Market, type SeoClient } from "../client.js";
import { significantWords } from "../words.js";

const MY_BUSINESS = "/business_data/google/my_business_info/live";
const REVIEWS_POST = "/business_data/google/reviews/task_post";
const REVIEWS_READY = "/business_data/google/reviews/tasks_ready";
const REVIEWS_GET = "/business_data/google/reviews/task_get";
const LISTINGS = "/business_data/business_listings/search/live";

/**
 * A queued Business Data job answers `task_get` with 40602 until it is done,
 * inside an otherwise healthy 20000 envelope — so the client raises it as an
 * error and this is the one error code that means "ask again", not "failed".
 */
const TASK_IN_QUEUE = 40602;

/** How many of the newest reviews to buy. The price is per task, not per review. */
const REVIEW_DEPTH = 20;

/** Kilometres around the prospect that count as "the others in your area". */
const PEER_RADIUS_KM = 10;

/** Comparable businesses to price out. Billed per returned row, so it is small. */
const PEER_LIMIT = 12;

/** A profile nobody has reviewed in this long has stopped working for them. */
const STALE_REVIEW_DAYS = 90;

/**
 * Hosts that are a page about the business, not the business's own site.
 *
 * Measured on a real profile: a restaurant with 5,259 reviews whose
 * Google "website" button points at a Facebook page. `hasWebsite` is still
 * true — there is a link — but the owner needs to be told where it goes, and
 * that is a different finding from having no link at all.
 */
const SOCIAL_HOSTS = [
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "linktr.ee",
  "wa.me",
  "whatsapp.com",
  "linkedin.com",
  "youtube.com",
  "wix.com",
  "google.com",
];

export interface LocalProfile {
  /** False means Google returned no profile for this name — not an empty one. */
  found: boolean;
  name: string | null;
  rating: number | null;
  reviewCount: number | null;
  category: string | null;
  claimed: boolean | null;
  hasPhotos: boolean | null;
  hasHours: boolean | null;
  hasPhone: boolean | null;
  hasWebsite: boolean | null;
  address: string | null;
  /** Where the profile's link actually points, when there is one. */
  websiteDomain: string | null;
  /**
   * Whether the profile Google returned is plausibly the business we asked
   * about. Null until checked; false means we found *a* profile, but not
   * theirs, and no claim may be made from it.
   */
  nameMatch: boolean | null;
}

/** The handles the other two calls need, which the report itself never shows. */
export interface ProfileLookup {
  cid: string | null;
  placeId: string | null;
  latitude: number | null;
  longitude: number | null;
  /** Google's own machine categories — what a comparable business is matched on. */
  categoryIds: string[];
}

export interface LocalReviews {
  average: number | null;
  /** Every review on the profile, which is not the number we read. */
  total: number | null;
  /**
   * Unanswered out of `sampled`, never out of `total`. We buy the newest
   * twenty; saying "312 unanswered" from a sample of twenty would be a figure
   * we made up, and it is the kind a prospect checks.
   */
  unanswered: number | null;
  /** How many reviews were actually read — the denominator of `unanswered`. */
  sampled: number | null;
  newestAt: string | null;
}

export interface LocalPeer {
  name: string;
  rating: number | null;
  reviewCount: number | null;
}

/** One gap, already in the words the business owner would use for it. */
export interface LocalFinding {
  title: string;
  detail: string;
  /** The number the finding is about, when it has one. */
  count: number | null;
}

export interface LocalSection {
  businessName: string;
  domain: string | null;
  market: { locationCode: number | null; languageCode: string | null };
  profile: LocalProfile;
  reviews: LocalReviews | null;
  peers: LocalPeer[];
  peerAverageRating: number | null;
  peerAverageReviews: number | null;
  findings: LocalFinding[];
  /** What could not be measured, named for the operator and not for the client. */
  omitted: string[];
  costUsd: number;
}

export interface LocalInput {
  businessName: string;
  /** Their own site, so a profile pointing somewhere else can be spotted. */
  domain?: string;
  market?: Market;
  /** Test seam: the polling loop, so the suite never waits on a real queue. */
  waitMs?: number;
  maxWaitMs?: number;
  now?: Date;
}

const num = (value: unknown): number | null => (typeof value === "number" ? value : null);
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const flag = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

/** Bare host, so `https://www.example.com/x` and `example.com` compare equal. */
export function hostOf(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  return raw
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/^www\./i, "")
    .split("/")[0]
    .toLowerCase() || null;
}

function isSocial(host: string | null): boolean {
  if (!host) return false;
  return SOCIAL_HOSTS.some((social) => host === social || host.endsWith(`.${social}`));
}

/** The profile a business has when Google has never heard of it. */
export const NO_PROFILE: LocalProfile = {
  found: false,
  name: null,
  rating: null,
  reviewCount: null,
  category: null,
  claimed: null,
  hasPhotos: null,
  hasHours: null,
  hasPhone: null,
  hasWebsite: null,
  address: null,
  websiteDomain: null,
  nameMatch: null,
};

const NO_LOOKUP: ProfileLookup = {
  cid: null,
  placeId: null,
  latitude: null,
  longitude: null,
  categoryIds: [],
};

/**
 * Read `my_business_info`'s one item.
 *
 * `items` arrives as `null` rather than `[]` when there is no profile, and
 * `items_count` is 0 — which is exactly the case this section exists to tell
 * apart from an empty profile, so a missing item produces `found: false` and
 * nothing else, never a row of zeros.
 */
export function readProfile(raw: unknown): { profile: LocalProfile; lookup: ProfileLookup } {
  if (!raw || typeof raw !== "object") return { profile: NO_PROFILE, lookup: NO_LOOKUP };
  const item = raw as Record<string, unknown>;

  const rating = (item.rating ?? {}) as Record<string, unknown>;
  const workHours = ((item.work_time ?? {}) as Record<string, unknown>).work_hours as
    | Record<string, unknown>
    | undefined;
  const timetable = workHours?.timetable as Record<string, unknown> | undefined;
  const websiteDomain = hostOf(item.domain) ?? hostOf(item.url);

  // `total_photos` is the only photo signal the endpoint carries; there is no
  // photo list. Absent means unknown, 0 means Google counted none.
  const photos = num(item.total_photos);

  return {
    profile: {
      found: true,
      name: text(item.title) ?? text(item.original_title),
      rating: num(rating.value),
      reviewCount: num(rating.votes_count),
      category: text(item.category),
      claimed: flag(item.is_claimed),
      hasPhotos: photos === null ? null : photos > 0,
      hasHours: timetable ? Object.keys(timetable).length > 0 : null,
      hasPhone: text(item.phone) !== null,
      hasWebsite: websiteDomain !== null,
      address: text(item.address),
      websiteDomain,
      nameMatch: null,
    },
    lookup: {
      cid: text(item.cid),
      placeId: text(item.place_id),
      latitude: num(item.latitude),
      longitude: num(item.longitude),
      categoryIds: Array.isArray(item.category_ids)
        ? item.category_ids.filter((entry): entry is string => typeof entry === "string")
        : [],
    },
  };
}

/**
 * Words that identify a kind of business rather than a business.
 *
 * Kept deliberately short. Its only job is to stop "restaurant" matching every
 * restaurant in the city; anything longer starts throwing away the words that
 * actually name a company.
 */
const GENERIC_WORDS = new Set([
  "ltd",
  "inc",
  "llc",
  "the",
  "and",
  "restaurant",
  "cafe",
  "company",
  "shop",
  "store",
  "branch",
]);

function nameTokens(value: string): Set<string> {
  const tokens = new Set<string>();
  for (const word of significantWords(value)) {
    if (!GENERIC_WORDS.has(word)) tokens.add(word);
  }
  return tokens;
}

/**
 * Is the profile Google returned actually theirs?
 *
 * `my_business_info` takes a phrase, not an id, and answers with whatever
 * Google's panel matches. Measured live: asking for one events company came
 * back with a near-namesake — a real, complete, entirely different company. Every
 * number in this section would then have been true about someone else, in a
 * document sent to the prospect. Nothing about that failure is visible in the
 * response, so it is checked here instead.
 *
 * Two ways to be sure, both mechanical: the profile links to the domain the
 * operator gave, or it shares a naming word with what was asked for. The name
 * test is deliberately loose — a business is often listed under a fuller name
 * than anyone types — and it can still be fooled by two businesses that share
 * a word, which is why a false result omits the section rather than accusing
 * anyone of anything.
 */
export function profileMatches(input: {
  asked: string;
  found: string | null;
  askedDomain?: string | null;
  foundDomain?: string | null;
}): boolean {
  const askedHost = hostOf(input.askedDomain);
  if (askedHost && input.foundDomain && askedHost === input.foundDomain) return true;
  if (!input.found) return false;

  const asked = nameTokens(input.asked);
  const found = nameTokens(input.found);
  if (asked.size === 0 || found.size === 0) return false;
  return [...asked].some((token) => found.has(token));
}

/**
 * Read the reviews task's result: the head carries the totals, the items the
 * sample. Both are needed and they answer different questions — the head knows
 * how many reviews exist, only the items know whether anyone replied to them.
 */
export function readReviews(head: unknown, rows: unknown[]): LocalReviews | null {
  if (!head || typeof head !== "object") return null;
  const result = head as Record<string, unknown>;
  const rating = (result.rating ?? {}) as Record<string, unknown>;

  const items = rows.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
  const stamps = items
    .map((row) => text(row.timestamp))
    .filter((stamp): stamp is string => stamp !== null)
    .sort();

  return {
    average: num(rating.value),
    total: num(result.reviews_count) ?? num(rating.votes_count),
    unanswered: items.length > 0 ? items.filter((row) => text(row.owner_answer) === null).length : null,
    sampled: items.length > 0 ? items.length : null,
    newestAt: stamps.length > 0 ? stamps[stamps.length - 1] : null,
  };
}

/** One row of `business_listings/search`, which nests its rating like the profile. */
export function readPeer(raw: unknown): LocalPeer | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const name = text(item.title) ?? text(item.original_title);
  if (!name) return null;
  const rating = (item.rating ?? {}) as Record<string, unknown>;
  return { name, rating: num(rating.value), reviewCount: num(rating.votes_count) };
}

/**
 * DataForSEO stamps a review `2026-09-15 21:19:33 +00:00` — a space before the
 * date's time and another before its offset, which `Date.parse` reads on V8
 * and not everywhere else. Normalised here rather than trusted.
 */
export function parseStamp(value: string): number | null {
  const iso = value.trim().replace(" ", "T").replace(/\s+([+-]\d{2}:?\d{2}|Z)$/i, "$1");
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Average only over the peers that carry the figure; an absent one is not a zero. */
function averageOf(values: (number | null)[], decimals: number): number | null {
  const measured = values.filter((value): value is number => value !== null);
  if (measured.length === 0) return null;
  const mean = measured.reduce((total, value) => total + value, 0) / measured.length;
  return Number(mean.toFixed(decimals));
}

export function peerAverages(peers: LocalPeer[]): {
  peerAverageRating: number | null;
  peerAverageReviews: number | null;
} {
  return {
    peerAverageRating: averageOf(peers.map((peer) => peer.rating), 2),
    peerAverageReviews: averageOf(peers.map((peer) => peer.reviewCount), 0),
  };
}

/**
 * The gaps, in the owner's language.
 *
 * Every finding below is guarded on the figure it is made of actually being
 * present. That is the whole discipline of this file: "no reviews were
 * answered" may only be said when we read reviews and none had a reply, never
 * when the reviews call failed — the second case is an omission, and it is
 * reported to the operator instead.
 */
export function localFindings(input: {
  profile: LocalProfile;
  reviews: LocalReviews | null;
  peers: LocalPeer[];
  peerAverageRating: number | null;
  peerAverageReviews: number | null;
  domain?: string;
  now?: Date;
}): LocalFinding[] {
  const { profile, reviews, peers, peerAverageRating, peerAverageReviews } = input;
  const findings: LocalFinding[] = [];

  // A profile that belongs to somebody else supports no finding at all, not
  // even a cautious one. The operator is told in `omitted`; the client is not
  // told anything, which is the only safe output here.
  if (profile.found && profile.nameMatch === false) return findings;

  if (!profile.found) {
    findings.push({
      title: "The business has no Google profile",
      detail:
        "A Google search for the business name found no business profile. Anyone looking for you on Maps does not see you, does not see a phone number and cannot navigate to you.",
      count: null,
    });
    return findings;
  }

  if (profile.claimed === false) {
    findings.push({
      title: "You do not own your Google profile",
      detail:
        "The profile exists but nobody has claimed it. Until that happens anyone can suggest changes to it, and you cannot update details, add photos or reply to reviews.",
      count: null,
    });
  }

  if (profile.hasPhotos === false) {
    findings.push({
      title: "No photos on the profile",
      detail: "A profile without photos looks abandoned, and customers choose by what they see before they read.",
      count: null,
    });
  }

  if (profile.hasHours === false) {
    findings.push({
      title: "No opening hours",
      detail: "Without opening hours Google cannot say whether you are open now, and a customer searching now will move on.",
      count: null,
    });
  }

  if (profile.hasPhone === false) {
    findings.push({
      title: "No phone number on the profile",
      detail: "There is no call button. Every phone enquiry that could have come from the map simply does not arrive.",
      count: null,
    });
  }

  if (profile.hasWebsite === false) {
    findings.push({
      title: "No link to the website",
      detail: "The profile points nowhere, so everyone who reaches it stops there.",
      count: null,
    });
  } else if (isSocial(profile.websiteDomain)) {
    findings.push({
      title: "The profile link leads to a social network",
      detail: `The website button on the profile leads to ${profile.websiteDomain}, not to your site. The traffic from Google stays there.`,
      count: null,
    });
  } else if (input.domain && profile.websiteDomain && hostOf(input.domain) !== profile.websiteDomain) {
    findings.push({
      title: "The profile link leads to a different address",
      detail: `The profile lists ${profile.websiteDomain}, and the site checked is ${hostOf(input.domain)}. Anyone who clicks ends up somewhere else.`,
      count: null,
    });
  }

  if (reviews) {
    if (reviews.unanswered !== null && reviews.sampled !== null && reviews.unanswered > 0) {
      const all = reviews.unanswered === reviews.sampled;
      findings.push({
        title: all ? "No review has been answered" : "Some reviews are unanswered",
        detail: all
          ? `The latest ${reviews.sampled} reviews were checked, and none has a reply from the business. A reply is visible to everyone who reads, and Google favours a business that answers.`
          : `Of the latest ${reviews.sampled} reviews, ${reviews.unanswered} have no reply.`,
        count: reviews.unanswered,
      });
    }

    if (reviews.newestAt) {
      const newest = parseStamp(reviews.newestAt);
      const now = (input.now ?? new Date()).getTime();
      const days = newest === null ? null : Math.floor((now - newest) / 86_400_000);
      if (days !== null && days > STALE_REVIEW_DAYS) {
        findings.push({
          title: "No recent reviews",
          detail: `The last review was written ${days} days ago. A quiet profile slips below businesses that get reviews every month.`,
          count: days,
        });
      }
    }
  }

  // Everything below compares against the neighbours, so it only runs when
  // there were neighbours to compare against.
  if (peers.length > 0) {
    if (peerAverageReviews !== null && profile.reviewCount !== null && profile.reviewCount < peerAverageReviews) {
      const behind = Math.round(peerAverageReviews - profile.reviewCount);
      findings.push({
        title: "Fewer reviews than similar businesses",
        detail: `Businesses in the same category and area have ${peerAverageReviews} reviews on average, and you have ${profile.reviewCount}. In a Maps search this is one of the things that decides who appears first.`,
        count: behind,
      });
    }

    // A tenth of a star is noise in a small sample; a fifth is a difference a
    // customer sees on the screen before reading a word.
    if (
      peerAverageRating !== null &&
      profile.rating !== null &&
      peerAverageRating - profile.rating >= 0.2
    ) {
      findings.push({
        title: "Lower rating than similar businesses",
        detail: `Your rating is ${profile.rating}, and the area average is ${peerAverageRating}.`,
        count: null,
      });
    }
  }

  return findings;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Collect a queued reviews task.
 *
 * `tasks_ready` is the free readiness signal and is polled first, but it is
 * not trusted as the only one: the listing can lag, and a task that is ready
 * but unlisted would otherwise be abandoned after paying for it. So the loop
 * also tries `task_get` directly and only treats 40602 ("Task In Queue") as a
 * reason to wait — any other failure is a real failure and stops the wait.
 */
async function collectReviews(
  client: SeoClient,
  taskId: string,
  waitMs: number,
  maxWaitMs: number
): Promise<{ head: Record<string, unknown> | null; rows: unknown[]; costUsd: number }> {
  const deadline = Date.now() + maxWaitMs;
  let costUsd = 0;

  for (;;) {
    try {
      const ready = await client.get(REVIEWS_READY);
      costUsd += ready.costUsd;
      const listed = ready.results.some((row) => row.id === taskId);
      if (listed || Date.now() >= deadline) {
        const got = await client.get(`${REVIEWS_GET}/${taskId}`);
        costUsd += got.costUsd;
        return { head: got.head, rows: got.rows, costUsd };
      }
    } catch (error) {
      const queued = error instanceof SeoApiError && error.providerCode === TASK_IN_QUEUE;
      if (!queued || Date.now() >= deadline) throw error;
    }
    if (Date.now() >= deadline) {
      throw new SeoApiError("The reviews task was still queued when we gave up waiting.", 504);
    }
    await sleep(waitMs);
  }
}

/**
 * Build the local section.
 *
 * Never throws. A section of a sales document is allowed to be short; it is
 * not allowed to take the document down with it, and it is not allowed to fill
 * a hole with a plausible number. Each of the three calls fails on its own and
 * says so in `omitted`.
 *
 * The order is not parallel by accident: both the reviews task and the peer
 * search need identifiers only the profile call returns — the business's `cid`
 * to ask for its reviews, and its coordinates and Google category to find
 * comparable businesses. Without a profile there is nothing to ask either
 * question about, and that absence is itself the section's headline.
 */
export async function buildLocalSection(client: SeoClient, input: LocalInput): Promise<LocalSection> {
  const market = input.market ?? {};
  const businessName = input.businessName.trim();
  const omitted: string[] = [];
  let costUsd = 0;

  async function attempt<T>(name: string, run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (error) {
      logger.warn({ error, businessName, section: name }, "[SEO] Local section unavailable");
      omitted.push(name);
      return null;
    }
  }

  const section: LocalSection = {
    businessName,
    domain: input.domain?.trim() ? hostOf(input.domain) : null,
    market: { locationCode: market.locationCode ?? null, languageCode: market.languageCode ?? null },
    profile: NO_PROFILE,
    reviews: null,
    peers: [],
    peerAverageRating: null,
    peerAverageReviews: null,
    findings: [],
    omitted,
    costUsd: 0,
  };

  if (!businessName) {
    omitted.push("profile:no-business-name");
    return section;
  }

  const info = await attempt("profile", () =>
    client.post(MY_BUSINESS, { keyword: businessName }, market)
  );
  costUsd += info?.costUsd ?? 0;

  // A failed call and an empty answer are different things, and only the
  // second one may be shown to a client as "no profile". When the call itself
  // failed, `found` stays false but the section is marked as unmeasured, so
  // the operator sees it before the prospect does.
  if (!info) {
    section.costUsd = Number(costUsd.toFixed(6));
    return section;
  }

  const { profile, lookup } = readProfile(info.rows[0]);
  if (profile.found) {
    profile.nameMatch = profileMatches({
      asked: businessName,
      found: profile.name,
      askedDomain: input.domain,
      foundDomain: profile.websiteDomain,
    });
  }
  section.profile = profile;

  // Buying reviews and neighbours for a business that is not the prospect
  // spends money to produce a section that must then be thrown away.
  if (profile.nameMatch === false) {
    omitted.push("profile:name-mismatch");
    section.costUsd = Number(costUsd.toFixed(6));
    return section;
  }

  if (!profile.found) {
    section.findings = localFindings({
      profile,
      reviews: null,
      peers: [],
      peerAverageRating: null,
      peerAverageReviews: null,
      domain: input.domain,
      now: input.now,
    });
    section.costUsd = Number(costUsd.toFixed(6));
    return section;
  }

  const waitMs = input.waitMs ?? 3_000;
  const maxWaitMs = input.maxWaitMs ?? 45_000;

  const [reviews, peerRows] = await Promise.all([
    lookup.cid
      ? attempt("reviews", async () => {
          const posted = await client.post(
            REVIEWS_POST,
            { cid: lookup.cid, depth: REVIEW_DEPTH, sort_by: "newest" },
            market
          );
          if (!posted.taskId) throw new SeoApiError("The reviews task came back without an id.", 502);
          const collected = await collectReviews(client, posted.taskId, waitMs, maxWaitMs);
          return { posted, collected };
        })
      : Promise.resolve(null),

    // `business_listings/search` has no location or language parameter at all —
    // it is a database of places, not a search in a market, and the
    // location_code the client attaches is dropped silently. It is matched on
    // Google's machine category plus a radius around the prospect's own pin,
    // which is why this call cannot run without the profile.
    //
    // Only the *first* category id is sent. Measured on a Jaffa hummus place:
    // its ids are ["arab_restaurant", "restaurant"], and sending both returned
    // Taizu and Thai House as its peers, which put "the others average 8,784
    // reviews" in front of an owner whose real neighbours have a few hundred.
    // The narrow category returns fewer businesses, and they are the right ones.
    lookup.latitude !== null && lookup.longitude !== null && lookup.categoryIds.length > 0
      ? attempt("peers", () =>
          client.post(
            LISTINGS,
            {
              categories: [lookup.categoryIds[0]],
              location_coordinate: `${lookup.latitude},${lookup.longitude},${PEER_RADIUS_KM}`,
              limit: PEER_LIMIT,
              order_by: ["rating.votes_count,desc"],
            },
            market
          )
        )
      : Promise.resolve(null),
  ]);

  if (!lookup.cid) omitted.push("reviews:no-cid");
  if (lookup.latitude === null || lookup.longitude === null) omitted.push("peers:no-coordinates");
  else if (lookup.categoryIds.length === 0) omitted.push("peers:no-category");

  costUsd += reviews?.posted.costUsd ?? 0;
  costUsd += reviews?.collected.costUsd ?? 0;
  costUsd += peerRows?.costUsd ?? 0;

  section.reviews = reviews ? readReviews(reviews.collected.head, reviews.collected.rows) : null;
  if (reviews && !section.reviews) omitted.push("reviews:empty");

  // The listing database holds the prospect too, and a business is not its own
  // competitor — nor is a second branch of it, which is why the drop is on the
  // Google id rather than on the name.
  const selfCid = lookup.cid;
  section.peers = (peerRows?.rows ?? [])
    .filter((row) => {
      const cid = text((row as Record<string, unknown>).cid);
      return !selfCid || cid !== selfCid;
    })
    .map(readPeer)
    .filter((peer): peer is LocalPeer => peer !== null)
    .slice(0, PEER_LIMIT);
  if (peerRows && section.peers.length === 0) omitted.push("peers:none-comparable");

  const averages = peerAverages(section.peers);
  section.peerAverageRating = averages.peerAverageRating;
  section.peerAverageReviews = averages.peerAverageReviews;

  section.findings = localFindings({
    profile: section.profile,
    reviews: section.reviews,
    peers: section.peers,
    peerAverageRating: section.peerAverageRating,
    peerAverageReviews: section.peerAverageReviews,
    domain: input.domain,
    now: input.now,
  });

  section.omitted = [...new Set(omitted)];
  section.costUsd = Number(costUsd.toFixed(6));
  return section;
}
