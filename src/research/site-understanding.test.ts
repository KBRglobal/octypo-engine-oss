import { describe, expect, it } from "vitest";
import { pageSignalFromHtml, parseSeedResponse } from "./site-understanding.js";

describe("site understanding", () => {
  it("extracts the site's own positioning from page metadata", () => {
    const signal = pageSignalFromHtml("https://example.com/", `
      <html><head><title>Lisbon for visitors | Lisbon Guide</title>
      <meta name="description" content="Hotels, flights, attractions and real estate in Lisbon"></head>
      <body><h1><span>Holidays and investment in Lisbon</span></h1></body></html>`);
    expect(signal).toEqual({
      url: "https://example.com/",
      title: "Lisbon for visitors | Lisbon Guide",
      description: "Hotels, flights, attractions and real estate in Lisbon",
      heading: "Holidays and investment in Lisbon",
    });
  });

  it("accepts only a bounded, deduplicated JSON seed list", () => {
    expect(parseSeedResponse('```json\n["flights to lisbon", "hotels in lisbon", "flights to lisbon"]\n```')).toEqual([
      "flights to lisbon", "hotels in lisbon",
    ]);
    expect(parseSeedResponse("not json")).toEqual([]);
  });
});
