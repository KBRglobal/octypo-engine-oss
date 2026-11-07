import { describe, expect, it } from "vitest";
import { auditPage } from "./rules.js";
import type { LivePage } from "./types.js";

const good = (overrides: Partial<LivePage> = {}): LivePage => ({
  url: "https://northport.example.com/articles/flights/", path: "/articles/flights/", status: 200,
  title: "Flights to Northport: airlines, times and prices", h1: "Flights to Northport: airlines, times and prices",
  opening: "Looking for flights to Northport? Here you will find active airlines, flight times, price ranges and entry rules checked against official sources. The page explains how to compare tickets, which limits to check before booking, when prices usually rise, and what to verify again on the day of purchase so nothing surprises you at the airport.",
  text: "flights to Northport airlines times prices updated page frequent questions", canonical: "https://northport.example.com/articles/flights/", noindex: false,
  internalLinks: ["https://northport.example.com/", "https://northport.example.com/getting-around/"], externalLinks: [], faqQuestions: [], ...overrides,
});

describe("OctyGate emergency rules", () => {
  it("marks every rule failure as an emergency", () => {
    const page = good({ status: 404, noindex: true, canonical: "", opening: "Too short", externalLinks: ["https://dead.example/"] });
    const incidents = auditPage(page, [page], new Set(), new Set(["https://dead.example/"]));
    expect(new Set(incidents.map((item) => item.rule))).toEqual(new Set(["intent", "capsule", "truth", "links", "technical"]));
    expect(incidents.every((item) => item.status === "emergency" && item.repair)).toBe(true);
  });

  it("detects unsupported FAQ schema", () => {
    const page = good({ faqQuestions: ["Is there a direct flight to Northport?"] });
    expect(auditPage(page, [good({ url: "https://northport.example.com/", path: "/", internalLinks: [page.url] }), page], new Set([page.url]), new Set()).some((item) => item.rule === "technical")).toBe(true);
  });

  it("detects cannibalisation between unconnected live pages", () => {
    const page = good();
    const twin = good({ url: "https://northport.example.com/articles/northport-flights/", path: "/articles/northport-flights/" });
    const incidents = [page, twin].flatMap((candidate) => auditPage(candidate, [page, twin], new Set([page.url, twin.url]), new Set()));
    expect(incidents.some((item) => item.rule === "duplicates")).toBe(true);
  });

  it("flags a filler opening and reads a site in any script", () => {
    const filler = good({ opening: `In today's fast-paced world ${good().opening}` });
    const incidents = auditPage(filler, [filler], new Set([filler.url]), new Set());
    expect(incidents.find((item) => item.rule === "capsule")?.evidence.modelPhrase).toBe("in today's fast-paced world");
    const japanese = "東京都の地下鉄の運賃と路線の案内";
    const twinA = good({ title: japanese, h1: japanese });
    const twinB = good({ url: "https://northport.example.com/articles/fares/", path: "/articles/fares/", title: japanese, h1: japanese });
    const found = [twinA, twinB].flatMap((page) => auditPage(page, [twinA, twinB], new Set([twinA.url, twinB.url]), new Set()));
    expect(found.some((item) => item.rule === "duplicates")).toBe(true);
  });
});
