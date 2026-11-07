import { describe, expect, it } from "vitest";

import { normaliseText, type Concept } from "../../lib/topic-terms.js";
import { addStory, buildNewsIndex, eventsOf, findNewsDuplicate, type PastStory } from "./news-duplicate.js";

const NOW = new Date("2026-09-27T09:00:00Z");

/** A fictional city site's articles (title + slug + date), the 21 days before NOW. */
const RECENT: PastStory[] = [
  { slug: "lantern-park-season-31-opening-vip-packs", title: "Lantern Park season 31: opening 14 October, VIP from 1,890", at: "2026-09-26" },
  { slug: "saltline-steakhouse-northport-mall", title: "Saltline at Northport Mall: a steak and burger restaurant on the way", at: "2026-09-25" },
  { slug: "blue-wing-easton-northport-daily-flights", title: "Blue Wing from Easton: 10 daily flights to Northport and what it means", at: "2026-09-25" },
  { slug: "harbor-air-northport-route-suspended-november", title: "Harbor Air suspended Northport flights until 30 November 2026", at: "2026-09-25" },
  { slug: "northport-new-malls-2026", title: "What is new in Northport malls: The Grand opens, and what else is coming", at: "2026-09-25" },
  { slug: "northport-attractions-reopen-outdoor-season", title: "Outdoor season in Northport 2026: when the seasonal attractions reopen", at: "2026-09-25" },
  { slug: "northport-creek-gardens-1400-homes-project", title: "Creek Gardens project in Northport: 1,400 homes and 817 million", at: "2026-09-23" },
  { slug: "northport-sevens-tickets-on-sale", title: "Tickets for Northport Sevens 2026: how to get them in time", at: "2026-09-20" },
  { slug: "ciel-northport-marina-tallest-hotel", title: "Ciel hotel opens in Northport Marina", at: "2026-09-17" },
  { slug: "next-driverless-taxi-northport-begins-free", title: "Driverless taxi in Northport 2026: two operators launch a pilot", at: "2026-09-15" },
  { slug: "easton-northport-direct-flights-ban-extended-october-2026", title: "Direct flights ban to Northport extended until October 2026", at: "2026-09-15" },
  { slug: "northport-holding-off-plan-financing", title: "New off-plan financing in Northport from two lenders", at: "2026-09-15" },
  {
    slug: "rosa-vance-coming-northport-opera-2026",
    title: "ローザ・ヴァンス、ノースポート歌劇場で新作を上演",
    feedTitle: "Rosa Vance to perform at Northport Opera in 2026",
    at: "2026-09-12",
  },
];

/** Names this fictional site spells two ways; the venue is a weak concept. */
const CONCEPTS: Concept[] = [
  { id: "harborair", phrases: ["harbor air", "harborair"] },
  { id: "lanternpark", phrases: ["lantern park", "lanternpark"] },
  { id: "northportopera", phrases: ["northport opera"], weak: true },
];

// Learnt from the corpus itself: "northport" is in nearly every headline.
const index = buildNewsIndex(RECENT, [], CONCEPTS);

function dup(title: string, idx = index) {
  return findNewsDuplicate({ title }, idx, { now: NOW });
}

describe("the same story again (must be caught)", () => {
  const cases: Array<[string, string]> = [
    ["Harbor Air flights to Northport cancelled until 30 November: what to do now", "harbor-air-northport-route-suspended-november"],
    ["Harbor Air pauses Northport flights 2026: what happened and what comes next", "harbor-air-northport-route-suspended-november"],
    ["Lantern Park Northport 2026-2027: opens on 14 October", "lantern-park-season-31-opening-vip-packs"],
    ["Season 31 of Lantern Park opens on 14 October: what to know before your visit", "lantern-park-season-31-opening-vip-packs"],
    ["Rosa Vance adds shows in Northport in November 2026", "rosa-vance-coming-northport-opera-2026"],
    // The same stories worded by other feeds, one spelling the name differently,
    // and one meeting a non-English article through the feed title it came from.
    ["HarborAir suspends Northport flights until November 30", "harbor-air-northport-route-suspended-november"],
    ["Harbor Air cancels all Northport flights through November", "harbor-air-northport-route-suspended-november"],
    ["Lantern Park Season 31 opens on October 14", "lantern-park-season-31-opening-vip-packs"],
    ["Rosa Vance adds two more Northport shows in November", "rosa-vance-coming-northport-opera-2026"],
  ];

  it.each(cases)("%s", (title, winner) => {
    const match = dup(title);
    expect(match, title).not.toBeNull();
    expect(match!.story.slug).toBe(winner);
    expect(match!.sharedEvents.length + match!.sharedEntities.length).toBeGreaterThan(1);
  });
});

describe("different stories (must NOT be caught)", () => {
  const cases = [
    // an earlier, different decision about the same ban
    "Direct flights ban from Easton cancelled",
    // same entity, different development
    "Harbor Air restarts flights to Northport in December",
    "Harbor Air resumes Northport flights in December",
    // same event, different entity (and the same venue)
    "Mika Stone comes to Northport Opera with a new show",
    "Mika Stone to perform at Northport Opera",
    "Miracle Garden opens its new season on October 1",
    "Blue Wing suspends flights to Westbay",
    // unrelated
    "Northport Metro Blue Line construction update",
    "Gold prices in Northport fell this week",
    "Tower Square light show for National Day",
  ];

  it.each(cases)("%s", (title) => {
    expect(dup(title)).toBeNull();
  });
});

describe("window, self-match and in-run memory", () => {
  it("ignores a story older than 21 days", () => {
    const old = buildNewsIndex(
      [{ slug: "harbor-air-northport-route-suspended-november", title: "Harbor Air suspended Northport flights until 30 November 2026", at: "2026-09-01" }],
      ["northport"],
      CONCEPTS
    );
    expect(dup("Harbor Air pauses Northport flights", old)).toBeNull();
    expect(findNewsDuplicate({ title: "Harbor Air pauses Northport flights" }, old, { now: new Date("2026-09-20T00:00:00Z") })).not.toBeNull();
  });

  it("never matches a feed item against itself", () => {
    const own = buildNewsIndex([{ feedItemId: "item-1", feedTitle: "Harbor Air suspends Northport flights", at: "2026-09-26" }], ["northport"], CONCEPTS);
    expect(findNewsDuplicate({ id: "item-1", title: "Harbor Air suspends Northport flights" }, own, { now: NOW })).toBeNull();
    expect(findNewsDuplicate({ id: "item-2", title: "Harbor Air suspends Northport flights" }, own, { now: NOW })).not.toBeNull();
  });

  it("catches two feeds reporting the same story in one run", () => {
    const run = buildNewsIndex([], ["northport"], CONCEPTS);
    expect(findNewsDuplicate({ title: "Rosa Vance announces Northport Opera show" }, run, { now: NOW })).toBeNull();
    addStory(run, { feedItemId: "a", feedTitle: "Rosa Vance announces Northport Opera show", at: NOW });
    expect(findNewsDuplicate({ id: "b", title: "Rosa Vance to perform in Northport this November" }, run, { now: NOW })).not.toBeNull();
  });

  it("without the city marked generic, a shared venue alone is still not a story", () => {
    const bare = buildNewsIndex([{ title: "Rosa Vance to perform at Northport Opera", at: "2026-09-20" }], [], CONCEPTS);
    expect(findNewsDuplicate({ title: "Mika Stone to perform at Northport Opera" }, bare, { now: NOW })).toBeNull();
  });
});

describe("headlines in other scripts need no vocabulary", () => {
  it("catches a repeated Japanese story and lets a different one through", () => {
    const stories = [{ title: "東京都が新しい地下鉄路線の開業を発表", at: "2026-09-26" }];
    const japanese = buildNewsIndex(stories);
    expect(dup("東京都の新しい地下鉄路線が開業へ", japanese)).not.toBeNull();
    expect(dup("大阪市が新しい水族館の建設を発表", japanese)).toBeNull();
  });

  it("catches a repeated Arabic story and lets a different one through", () => {
    const stories = [{ title: "بلدية المدينة تعلن افتتاح خط مترو جديد", at: "2026-09-26" }];
    const arabic = buildNewsIndex(stories);
    expect(dup("افتتاح خط مترو جديد في المدينة", arabic)).not.toBeNull();
    expect(dup("بلدية المدينة تعلن ميزانية العام المقبل", arabic)).toBeNull();
  });

  it("learns a word every headline repeats, in any script", () => {
    const stories = Array.from({ length: 8 }, (_, i) => ({ title: `ノースポート 話題${i} 記事${i}`, at: "2026-09-26" }));
    const learnt = buildNewsIndex(stories);
    for (const word of normaliseText("ノースポート").split(" ")) expect(learnt.generic.has(word), word).toBe(true);
  });
});

describe("eventsOf", () => {
  it("recognises the development", () => {
    expect([...eventsOf("Harbor Air suspended flights")]).toContain("halt");
    expect([...eventsOf("Harbor Air flights cancelled")]).toContain("halt");
    expect([...eventsOf("Lantern Park opens")]).toContain("open");
    expect([...eventsOf("Rosa Vance adds shows")]).toContain("show");
    expect([...eventsOf("The flights ban was extended")]).toEqual(["extend"]);
  });

  it("does not see events in look-alike words", () => {
    expect(eventsOf("Northport tourism season").size).toBe(0);
    expect([...eventsOf("showroom sales")]).not.toContain("show");
    expect([...eventsOf("shuttle bus")]).not.toContain("close");
  });

  it("finds no event in a language without a list", () => {
    expect(eventsOf("東京都が開業を発表").size).toBe(0);
  });
});
