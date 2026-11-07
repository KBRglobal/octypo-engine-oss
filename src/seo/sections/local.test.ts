import { describe, expect, it } from "vitest";

import { SeoClient } from "../client.js";
import {
  buildLocalSection,
  hostOf,
  localFindings,
  peerAverages,
  profileMatches,
  readPeer,
  readProfile,
  readReviews,
  type LocalPeer,
  type LocalProfile,
} from "./local.js";

/**
 * Every fixture below is a cut-down copy of a real answer, captured live on
 * 2026-09-17 against location 2826 / "en". The trimming removed fields this
 * file never reads (attributes, popular_times, photo urls); nothing was
 * reshaped, because the shapes are the only thing worth testing here — each
 * one of them is a guess someone could have got wrong.
 */

/** `/business_data/google/my_business_info/live` — "Harbor Grill Restaurant". */
const HARBOR_GRILL = {
  type: "google_business_info",
  title: "Harbor Grill - Old Port",
  original_title: "Harbor Grill",
  category: "Seafood restaurant",
  category_ids: ["arab_restaurant", "restaurant"],
  additional_categories: ["Restaurant"],
  cid: "9410202385071688036",
  address: "14 Quay Street, Bristol",
  address_info: { address: "14 Quay Street", city: "Bristol", country_code: "GB" },
  place_id: "ChIJaTKN-LlMHRURZEm7OjbBl4I",
  phone: "+9723-682-8355",
  // The live profile of a restaurant with 5,259 reviews points at Facebook.
  url: "https://m.facebook.com/pages/Harbor-Grill/396398840415380",
  domain: "m.facebook.com",
  total_photos: 1751,
  latitude: 32.0494446,
  longitude: 34.757403,
  is_claimed: true,
  rating: { rating_type: "Max5", value: 4.4, votes_count: 5259, rating_max: null },
  work_time: {
    work_hours: {
      timetable: {
        sunday: [{ open: { hour: 7, minute: 0 }, close: { hour: 16, minute: 0 } }],
        monday: [{ open: { hour: 7, minute: 0 }, close: { hour: 16, minute: 0 } }],
      },
      current_status: "close",
    },
  },
};

/** The same endpoint for a business Google has no panel for: `items` is null. */
const NO_PANEL = {
  keyword: "Eventra Productions",
  se_domain: "google.com",
  location_code: 2826,
  language_code: "he",
  item_types: null,
  items_count: 0,
  items: null,
};

/** `/business_data/google/reviews/task_get/{id}` — head plus two of its items. */
const REVIEWS_HEAD = {
  keyword: "cid:9410202385071688036",
  title: "Harbor Grill - Old Port",
  cid: "9410202385071688036",
  rating: { rating_type: "Max5", value: 4.4, votes_count: 5259, rating_max: 5 },
  reviews_count: 5259,
  items_count: 2,
};

const REVIEW_ITEMS = [
  {
    type: "google_reviews_search",
    timestamp: "2026-09-15 21:19:33 +00:00",
    rating: { rating_type: "Max5", value: 5, votes_count: null, rating_max: 5 },
    owner_answer: null,
    owner_timestamp: null,
  },
  {
    type: "google_reviews_search",
    timestamp: "2026-09-12 15:15:45 +00:00",
    rating: { rating_type: "Max5", value: 4, votes_count: null, rating_max: 5 },
    owner_answer: "Thank you!",
    owner_timestamp: "2026-09-13 08:00:00 +00:00",
  },
];

/** `/business_data/business_listings/search/live` — arab_restaurant, 10km. */
const LISTING_ITEMS = [
  {
    title: "Harbor Grill",
    category: "Arab restaurant",
    cid: "11811105144308314136",
    rating: { rating_type: "Max5", value: 4.6, votes_count: 2882, rating_max: null },
    is_claimed: false,
    total_photos: 993,
  },
  {
    title: "George's Diner",
    cid: "15623489493903315987",
    rating: { rating_type: "Max5", value: 4.5, votes_count: 485, rating_max: null },
  },
  {
    title: "Hummus Jara",
    cid: "12954016023390578025",
    rating: { rating_type: "Max5", value: 4.6, votes_count: 103, rating_max: null },
  },
  // The prospect's own listing comes back in its own peer search.
  {
    title: "Harbor Grill - Old Port",
    cid: "9410202385071688036",
    rating: { rating_type: "Max5", value: 4.4, votes_count: 5259, rating_max: null },
  },
];

const envelope = (result: unknown[], cost = 0, extra: Record<string, unknown> = {}) => ({
  status_code: 20000,
  status_message: "Ok.",
  cost,
  tasks: [{ id: "task-1", status_code: 20000, status_message: "Ok.", cost, result, ...extra }],
});

const queued = () => ({
  status_code: 20000,
  status_message: "Ok.",
  cost: 0,
  tasks: [
    { id: "task-1", status_code: 40602, status_message: "Task In Queue.", cost: 0, result: null },
  ],
});

/**
 * A client wired to a script of answers instead of the network.
 *
 * Keyed by the part of the path that identifies the call, so a test says what
 * each of the three endpoints returns and nothing has to know the order the
 * builder happens to run them in.
 */
function stubClient(script: Record<string, () => unknown>, seen: string[] = []) {
  const fetchImpl = (async (url: string | URL) => {
    const path = String(url);
    seen.push(path);
    const key = Object.keys(script).find((fragment) => path.includes(fragment));
    if (!key) throw new Error(`no stub for ${path}`);
    return { ok: true, status: 200, json: async () => script[key]!() } as unknown as Response;
  }) as unknown as typeof fetch;

  return new SeoClient(
    { login: "test", password: "test", locationCode: 2826, languageCode: "en" },
    { fetchImpl }
  );
}

const happyScript = (): Record<string, () => unknown> => ({
  "my_business_info": () => envelope([{ items_count: 1, items: [HARBOR_GRILL] }], 0.0054),
  "reviews/task_post": () => ({
    status_code: 20000,
    cost: 0.00075,
    tasks: [{ id: "task-1", status_code: 20100, status_message: "Task Created.", cost: 0.00075 }],
  }),
  "reviews/tasks_ready": () => envelope([{ id: "task-1", se: "google" }], 0),
  "reviews/task_get": () => envelope([{ ...REVIEWS_HEAD, items: REVIEW_ITEMS }], 0),
  "business_listings/search": () =>
    envelope([{ total_count: 4, count: 4, items: LISTING_ITEMS }], 0.01344),
});

describe("readProfile", () => {
  it("reads the live profile into the fields the report shows", () => {
    const { profile, lookup } = readProfile(HARBOR_GRILL);
    expect(profile).toEqual({
      found: true,
      name: "Harbor Grill - Old Port",
      rating: 4.4,
      reviewCount: 5259,
      category: "Seafood restaurant",
      claimed: true,
      hasPhotos: true,
      hasHours: true,
      hasPhone: true,
      hasWebsite: true,
      address: "14 Quay Street, Bristol",
      websiteDomain: "m.facebook.com",
      nameMatch: null,
    });
    expect(lookup).toEqual({
      cid: "9410202385071688036",
      placeId: "ChIJaTKN-LlMHRURZEm7OjbBl4I",
      latitude: 32.0494446,
      longitude: 34.757403,
      categoryIds: ["arab_restaurant", "restaurant"],
    });
  });

  // The whole point of the section: no panel is not an empty panel.
  it("returns a not-found profile rather than a row of zeros", () => {
    const { profile } = readProfile(NO_PANEL.items?.[0]);
    expect(profile.found).toBe(false);
    expect(profile.reviewCount).toBeNull();
    expect(profile.rating).toBeNull();
    expect(profile.claimed).toBeNull();
  });

  it("leaves an unreported photo count unknown instead of calling it none", () => {
    const { profile } = readProfile({ title: "x", rating: {} });
    expect(profile.hasPhotos).toBeNull();
    expect(readProfile({ title: "x", total_photos: 0 }).profile.hasPhotos).toBe(false);
  });

  it("reads hours only from a timetable that has days in it", () => {
    expect(readProfile({ title: "x" }).profile.hasHours).toBeNull();
    expect(readProfile({ title: "x", work_time: { work_hours: { timetable: {} } } }).profile.hasHours).toBe(
      false
    );
  });
});

describe("profileMatches", () => {
  // Measured live: this exact pair came back from one `my_business_info` call.
  it("rejects the different company Google matched the phrase to", () => {
    expect(profileMatches({ asked: "Eventra Productions", found: "Evento Group" })).toBe(false);
  });

  it("accepts a fuller listing of the same business", () => {
    expect(profileMatches({ asked: "Harbor Grill Restaurant", found: "Harbor Grill - Old Port" })).toBe(true);
  });

  it("does not match on the kind of business alone", () => {
    expect(profileMatches({ asked: "Nono Restaurant", found: "Saul Restaurant" })).toBe(false);
  });

  it("accepts a profile that links to the domain we were given", () => {
    expect(
      profileMatches({
        asked: "something else entirely",
        found: "Totally Different Name",
        askedDomain: "https://www.example.co.uk/",
        foundDomain: "example.co.uk",
      })
    ).toBe(true);
  });
});

describe("readReviews", () => {
  it("keeps the profile total and the sample apart", () => {
    const reviews = readReviews(REVIEWS_HEAD, REVIEW_ITEMS);
    expect(reviews).toEqual({
      average: 4.4,
      total: 5259,
      unanswered: 1,
      sampled: 2,
      newestAt: "2026-09-15 21:19:33 +00:00",
    });
  });

  // Saying "5,258 unanswered" from a sample of two is the invented figure this
  // whole file exists to avoid.
  it("never counts unanswered out of the profile total", () => {
    const reviews = readReviews(REVIEWS_HEAD, REVIEW_ITEMS);
    expect(reviews?.unanswered).toBeLessThanOrEqual(reviews?.sampled ?? 0);
  });

  it("leaves unanswered unknown when no reviews came back", () => {
    const reviews = readReviews(REVIEWS_HEAD, []);
    expect(reviews?.unanswered).toBeNull();
    expect(reviews?.sampled).toBeNull();
    expect(reviews?.total).toBe(5259);
  });

  it("reports nothing at all for a missing result", () => {
    expect(readReviews(null, [])).toBeNull();
  });
});

describe("readPeer and peerAverages", () => {
  it("reads a listing row", () => {
    expect(readPeer(LISTING_ITEMS[0])).toEqual({ name: "Harbor Grill", rating: 4.6, reviewCount: 2882 });
  });

  it("drops a row with no name, which nothing could be said about", () => {
    expect(readPeer({ rating: { value: 5 } })).toBeNull();
  });

  it("averages only the peers that carry the figure", () => {
    const peers: LocalPeer[] = [
      { name: "a", rating: 4.6, reviewCount: 100 },
      { name: "b", rating: 4.4, reviewCount: null },
      { name: "c", rating: null, reviewCount: 200 },
    ];
    expect(peerAverages(peers)).toEqual({ peerAverageRating: 4.5, peerAverageReviews: 150 });
  });

  it("reports no average rather than zero when nothing was measured", () => {
    expect(peerAverages([{ name: "a", rating: null, reviewCount: null }])).toEqual({
      peerAverageRating: null,
      peerAverageReviews: null,
    });
  });
});

describe("localFindings", () => {
  const base: LocalProfile = {
    found: true,
    name: "Business",
    rating: 4.4,
    reviewCount: 5259,
    category: "Restaurant",
    claimed: true,
    hasPhotos: true,
    hasHours: true,
    hasPhone: true,
    hasWebsite: true,
    address: "Street",
    websiteDomain: "example.co.uk",
    nameMatch: true,
  };
  const of = (findings: { title: string }[]) => findings.map((finding) => finding.title);

  it("names the absence of a profile as the finding", () => {
    const findings = localFindings({
      profile: { ...base, found: false },
      reviews: null,
      peers: [],
      peerAverageRating: null,
      peerAverageReviews: null,
    });
    expect(of(findings)).toEqual(["The business has no Google profile"]);
  });

  // A profile that turned out to belong to somebody else supports nothing.
  it("says nothing at all about a profile that is not theirs", () => {
    const findings = localFindings({
      profile: { ...base, nameMatch: false, claimed: false, hasPhotos: false },
      reviews: null,
      peers: [],
      peerAverageRating: null,
      peerAverageReviews: null,
    });
    expect(findings).toEqual([]);
  });

  it("stays silent about what it could not measure", () => {
    const findings = localFindings({
      profile: {
        ...base,
        claimed: null,
        hasPhotos: null,
        hasHours: null,
        hasPhone: null,
        hasWebsite: null,
        websiteDomain: null,
      },
      reviews: null,
      peers: [],
      peerAverageRating: null,
      peerAverageReviews: null,
    });
    expect(findings).toEqual([]);
  });

  it("separates a missing link from a link that goes to a social page", () => {
    const missing = localFindings({
      profile: { ...base, hasWebsite: false, websiteDomain: null },
      reviews: null,
      peers: [],
      peerAverageRating: null,
      peerAverageReviews: null,
    });
    expect(of(missing)).toEqual(["No link to the website"]);

    const social = localFindings({
      profile: { ...base, websiteDomain: "m.facebook.com" },
      reviews: null,
      peers: [],
      peerAverageRating: null,
      peerAverageReviews: null,
    });
    expect(of(social)).toEqual(["The profile link leads to a social network"]);
  });

  it("counts unanswered reviews out of the sample it read, and says so", () => {
    const findings = localFindings({
      profile: base,
      reviews: { average: 4.4, total: 5259, unanswered: 20, sampled: 20, newestAt: null },
      peers: [],
      peerAverageRating: null,
      peerAverageReviews: null,
    });
    expect(of(findings)).toEqual(["No review has been answered"]);
    expect(findings[0].count).toBe(20);
    expect(findings[0].detail).toContain("20");
    expect(findings[0].detail).not.toContain("5259");
  });

  it("calls a partly answered profile partly answered", () => {
    const findings = localFindings({
      profile: base,
      reviews: { average: 4.4, total: 5259, unanswered: 3, sampled: 20, newestAt: null },
      peers: [],
      peerAverageRating: null,
      peerAverageReviews: null,
    });
    expect(of(findings)).toEqual(["Some reviews are unanswered"]);
  });

  it("says nothing about answers on a profile whose reviews it never read", () => {
    const findings = localFindings({
      profile: base,
      reviews: { average: 4.4, total: 5259, unanswered: null, sampled: null, newestAt: null },
      peers: [],
      peerAverageRating: null,
      peerAverageReviews: null,
    });
    expect(findings).toEqual([]);
  });

  it("reads the provider's own timestamp format when ageing a review", () => {
    const stale = localFindings({
      profile: base,
      reviews: { average: 5, total: 2, unanswered: null, sampled: null, newestAt: "2022-03-22 15:07:15 +00:00" },
      peers: [],
      peerAverageRating: null,
      peerAverageReviews: null,
      now: new Date("2026-09-17T00:00:00Z"),
    });
    expect(of(stale)).toEqual(["No recent reviews"]);
    expect(stale[0].count).toBe(1639);

    const fresh = localFindings({
      profile: base,
      reviews: { average: 5, total: 2, unanswered: null, sampled: null, newestAt: "2026-09-15 21:19:33 +00:00" },
      peers: [],
      peerAverageRating: null,
      peerAverageReviews: null,
      now: new Date("2026-09-17T00:00:00Z"),
    });
    expect(fresh).toEqual([]);
  });

  it("compares against the neighbours only when there are neighbours", () => {
    const peers: LocalPeer[] = [
      { name: "a", rating: 4.6, reviewCount: 2882 },
      { name: "b", rating: 4.5, reviewCount: 485 },
    ];
    const { peerAverageRating, peerAverageReviews } = peerAverages(peers);
    const findings = localFindings({
      profile: { ...base, rating: 4.0, reviewCount: 100 },
      reviews: null,
      peers,
      peerAverageRating,
      peerAverageReviews,
    });
    expect(of(findings)).toEqual(["Fewer reviews than similar businesses", "Lower rating than similar businesses"]);
    expect(findings[0].count).toBe(1584);

    const alone = localFindings({
      profile: { ...base, rating: 4.0, reviewCount: 100 },
      reviews: null,
      peers: [],
      peerAverageRating: null,
      peerAverageReviews: null,
    });
    expect(alone).toEqual([]);
  });

  it("does not call a tenth of a star a lower rating", () => {
    const peers: LocalPeer[] = [{ name: "a", rating: 4.5, reviewCount: 10 }];
    const findings = localFindings({
      profile: { ...base, rating: 4.4, reviewCount: 5259 },
      reviews: null,
      peers,
      ...peerAverages(peers),
    });
    expect(of(findings)).toEqual([]);
  });
});

describe("buildLocalSection", () => {
  it("builds the whole section from the three live shapes", async () => {
    const section = await buildLocalSection(stubClient(happyScript()), {
      businessName: "Harbor Grill Restaurant",
      domain: "harborgrill.co.uk",
      market: { locationCode: 2826, languageCode: "en" },
      waitMs: 0,
    });

    expect(section.profile.found).toBe(true);
    expect(section.profile.nameMatch).toBe(true);
    expect(section.profile.reviewCount).toBe(5259);
    expect(section.reviews).toMatchObject({ total: 5259, unanswered: 1, sampled: 2 });
    expect(section.peerAverageRating).toBe(4.57);
    expect(section.omitted).toEqual([]);
    // 0.0054 profile + 0.00075 reviews task + 0.01344 listings.
    expect(section.costUsd).toBe(0.01959);
  });

  // The listings database holds the prospect too, and comparing a business to
  // itself is how "you have fewer reviews than average" becomes untrue.
  it("drops the prospect's own listing from its peers", async () => {
    const section = await buildLocalSection(stubClient(happyScript()), {
      businessName: "Harbor Grill Restaurant",
      waitMs: 0,
    });
    expect(section.peers.map((peer) => peer.name)).toEqual([
      "Harbor Grill",
      "George's Diner",
      "Hummus Jara",
    ]);
  });

  it("returns a not-found profile, and only that finding, for a business Google has no panel for", async () => {
    const section = await buildLocalSection(
      stubClient({ my_business_info: () => envelope([NO_PANEL], 0.0054) }),
      { businessName: "Eventra Productions", waitMs: 0 }
    );
    expect(section.profile.found).toBe(false);
    expect(section.reviews).toBeNull();
    expect(section.peers).toEqual([]);
    expect(section.findings.map((finding) => finding.title)).toEqual(["The business has no Google profile"]);
    expect(section.costUsd).toBe(0.0054);
  });

  // Buying reviews and neighbours for the wrong business spends money on a
  // section that then has to be thrown away.
  it("stops after the profile call when Google matched a different business", async () => {
    const seen: string[] = [];
    const section = await buildLocalSection(
      stubClient(
        {
          my_business_info: () =>
            envelope([{ items: [{ ...HARBOR_GRILL, title: "Evento Group", original_title: null }] }], 0.0054),
        },
        seen
      ),
      { businessName: "Eventra Productions", waitMs: 0 }
    );
    expect(section.profile.nameMatch).toBe(false);
    expect(section.findings).toEqual([]);
    expect(section.omitted).toContain("profile:name-mismatch");
    expect(seen.filter((path) => path.includes("reviews"))).toEqual([]);
    expect(seen.filter((path) => path.includes("business_listings"))).toEqual([]);
  });

  it("keeps the rest of the section when the reviews task never finishes", async () => {
    const script = happyScript();
    script["reviews/tasks_ready"] = () => envelope([], 0);
    script["reviews/task_get"] = () => queued();

    const section = await buildLocalSection(stubClient(script), {
      businessName: "Harbor Grill Restaurant",
      waitMs: 0,
      maxWaitMs: 0,
    });
    expect(section.reviews).toBeNull();
    expect(section.omitted).toContain("reviews");
    expect(section.peers).toHaveLength(3);
    expect(section.profile.found).toBe(true);
  });

  it("keeps the reviews when the peer search fails", async () => {
    const script = happyScript();
    script["business_listings/search"] = () => ({
      status_code: 40200,
      status_message: "Payment Required.",
      tasks: [],
    });

    const section = await buildLocalSection(stubClient(script), {
      businessName: "Harbor Grill Restaurant",
      waitMs: 0,
    });
    expect(section.omitted).toContain("peers");
    expect(section.peers).toEqual([]);
    expect(section.peerAverageReviews).toBeNull();
    expect(section.reviews?.total).toBe(5259);
  });

  // A section is allowed to be short. It is not allowed to take the document
  // down with it.
  it("never throws, and names what it could not measure", async () => {
    const section = await buildLocalSection(
      stubClient({
        my_business_info: () => ({ status_code: 40200, status_message: "Payment Required.", tasks: [] }),
      }),
      { businessName: "Harbor Grill Restaurant", waitMs: 0 }
    );
    expect(section.profile.found).toBe(false);
    // The call failed, so we do not know there is no profile — and we must not
    // tell a prospect that there is none.
    expect(section.findings).toEqual([]);
    expect(section.omitted).toEqual(["profile"]);
    expect(section.costUsd).toBe(0);
  });

  it("refuses an empty business name without spending anything", async () => {
    const seen: string[] = [];
    const section = await buildLocalSection(stubClient({}, seen), { businessName: "   " });
    expect(seen).toEqual([]);
    expect(section.omitted).toEqual(["profile:no-business-name"]);
    expect(section.costUsd).toBe(0);
  });
});

describe("hostOf", () => {
  it("compares two spellings of the same site as one", () => {
    expect(hostOf("https://www.Example.co.uk/page?x=1")).toBe("example.co.uk");
    expect(hostOf("example.co.uk")).toBe("example.co.uk");
    expect(hostOf(null)).toBeNull();
  });
});
