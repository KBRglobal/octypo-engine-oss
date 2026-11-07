/**
 * Realistic article fixtures.
 *
 * These are shaped like what the engine actually stores: `blocks[]` with
 * `text` / `heading` / `image` / `faq` entries, HTML inside the text blocks,
 * a stringified `seoSchema`, and a hero image with its alt text. Hand-written
 * toy strings would let the scorer pass tests it would fail in production.
 */

import type { ArticleQualityInput } from "../types.js";

/** The published articles the fixtures link to. Anything else is a dead link. */
export const PUBLISHED_SLUGS = [
  "tenancy-deposit-protection-schemes",
  "check-in-inventory-report-guide",
  "fair-wear-and-tear-explained",
  "how-to-photograph-a-rental-before-moving-in",
];

/** The RSS summary the article was written from. */
export const SOURCE_MATERIAL = `
Deposit disputes remain one of the most common friction points at the end of a
tenancy. Adjudicators repeatedly report that landlords lose claims not because
the damage was imaginary but because it was never evidenced: no check-in
inventory, no dated photographs, no invoices. Where a landlord does produce a
check-in report signed by the tenant, the deduction is far more likely to stand.
The Tenancy Deposit Scheme publishes annual guidance on the point. Cleaning
remains the single most disputed category, followed by damage to decoration.
`;

const HERO = "https://cdn.example.com/octypo/deposit-deduction-inventory-desk.jpg";

const GOOD_SCHEMA = JSON.stringify([
  {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: "Deposit Deduction Rules: What Can a Landlord Legally Withhold?",
    description:
      "A deposit deduction has to be evidenced, reasonable and tied to real damage. Here is what a landlord may withhold and how to challenge a claim.",
    image: [HERO],
    datePublished: "2026-08-01T09:00:00.000Z",
    dateModified: "2026-08-01T09:00:00.000Z",
    author: { "@type": "Person", name: "Octypo Editorial" },
    publisher: { "@type": "Organization", name: "Octypo", url: "https://octypo.example" },
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": "https://octypo.example/guides/deposit-deduction-rules",
    },
  },
]);

const FAQ_ITEMS = [
  {
    question: "Can a landlord charge for cleaning?",
    answer:
      "Only to return the property to the standard recorded at check-in, and only with evidence of the difference. A general wish for a cleaner flat is not a ground.",
  },
  {
    question: "How long does a landlord have to make a claim?",
    answer:
      "Schemes expect a claim within days of the tenancy ending. A landlord who waits months weakens the argument that the damage was caused by that tenant.",
  },
  {
    question: "What happens if the tenant disagrees?",
    answer:
      "The disputed amount goes to the scheme's free adjudication service. The money stays with the scheme until the adjudicator rules on the evidence.",
  },
  {
    question: "Does a signed inventory settle the argument?",
    answer:
      "A signed, dated check-in inventory with photographs is the strongest evidence either side can bring to an adjudicator, and it usually decides the outcome.",
  },
];

const INTRO_HTML = `<p>Every tenancy ends with the same question: how much of the money comes back.
A deposit deduction is not a fee a landlord may set at will, it is a claim against
your money that has to be justified line by line. Adjudicators throw out claims every
week, and almost never because the damage was imagined — they throw them out because
nobody wrote anything down. If the property was never recorded on the way in, there is
nothing to compare it against on the way out. Start with the
<a href="/guides/check-in-inventory-report-guide">check-in inventory report</a>, because
that single document decides most arguments before they begin.</p>`;

const SECTION_ONE_HTML = `<p>A fair deposit deduction has three parts: something changed, the
change is beyond fair wear and tear, and the cost of putting it right is evidenced. Miss
any one of those and the claim collapses. Cleaning is the most disputed category of all,
and it is disputed because landlords ask for a standard the property never had. The test
is the standard recorded at check-in, not the standard the landlord would like now.
Decoration comes next: a scuffed wall after two years is wear, a hole punched through
plasterboard is damage. The difference between the two is spelled out in
<a href="/guides/fair-wear-and-tear-explained">fair wear and tear</a>, and it is worth
reading before you accept any figure. Betterment matters too — a landlord cannot charge
a tenant for a brand new carpet to replace one that was already halfway through its life.
Evidence means dated photographs and real invoices, not an estimate written on a
letterhead after the argument started.</p>`;

const SECTION_TWO_HTML = `<p>Challenging a deposit deduction is procedural, not emotional. Ask for the
breakdown in writing, item by item, with the invoice behind each line. Put your own
evidence next to it: the check-in report, your move-out photographs, the meter readings.
Where the two disagree, say so plainly and in writing. Then push the disputed amount into
the scheme's adjudication service, which costs you nothing and is decided on documents
alone — there is no hearing to attend and no lawyer to pay. Your money stays with the
scheme while the adjudicator works, so there is no advantage to the landlord in delay.
Tenants who photograph the property on the day they arrive win these arguments far more
often than tenants who rely on memory, which is why
<a href="/guides/how-to-photograph-a-rental-before-moving-in">photographing a rental</a>
is the cheapest insurance in renting. If the deposit was never protected in the first
place, the argument changes shape entirely and the
<a href="/guides/tenancy-deposit-protection-schemes">protection schemes</a> guide explains
what you can claim instead.</p>`;

function baseBlocks() {
  return [
    { type: "text", id: "intro", data: { content: INTRO_HTML } },
    {
      type: "image",
      id: "img-1",
      data: {
        url: "https://cdn.example.com/octypo/inventory-clipboard.jpg",
        alt: "A signed check-in inventory report on a kitchen worktop",
      },
    },
    {
      type: "heading",
      id: "h2-1",
      data: { text: "What Counts as a Fair Deposit Deduction?", level: 2 },
    },
    { type: "text", id: "s1", data: { content: SECTION_ONE_HTML } },
    {
      type: "heading",
      id: "h2-2",
      data: { text: "How to Challenge a Claim Against Your Deposit", level: 2 },
    },
    { type: "text", id: "s2", data: { content: SECTION_TWO_HTML } },
    { type: "heading", id: "h2-faq", data: { text: "Frequently Asked Questions", level: 2 } },
    { type: "faq", id: "faq", data: { items: FAQ_ITEMS } },
  ];
}

/** Passes every criterion. The control case — if this fails, the scorer is wrong. */
export const goodArticle: ArticleQualityInput = {
  // Question-form title on purpose: the serp-alignment criterion grades H1
  // shape, and the control case must pass every criterion.
  title: "Deposit Deduction Rules: What Can a Landlord Legally Withhold?",
  // 51 words: inside the 40-60 band the answer-capsule criterion enforces.
  answerCapsule:
    "You get a bounded deposit-deduction answer here: landlords may deduct only documented damage beyond normal wear, unpaid rent and agreed cleaning costs, must itemise every deduction in writing within the statutory window, and cannot keep the deposit for routine repainting; if they miss the deadline you can reclaim the full amount.",
  metaTitle: "Deposit Deduction Rules Every Tenant Should Know",
  metaDescription:
    "A deposit deduction has to be evidenced, reasonable and tied to real damage. Learn what a landlord can withhold and how to challenge an unfair claim.",
  primaryKeyword: "deposit deduction",
  // The 2026-09-15 gates: a readable English slug and a publisher source.
  slug: "deposit-deduction-rules",
  sourceUrls: ["https://www.tenancydepositscheme.com/news/deposit-disputes-guidance"],
  blocks: baseBlocks(),
  heroImage: HERO,
  heroImageAlt: "Tenant reviewing a deposit deduction breakdown beside a check-in inventory",
  structuredData: GOOD_SCHEMA,
  publishedSlugs: PUBLISHED_SLUGS,
  targetWordCount: { min: 350, max: 900 },
  sourceMaterial: SOURCE_MATERIAL,
  siteUrl: "https://octypo.example",
};

/**
 * The same article with the keyword hammered into every sentence — the failure
 * mode an SEO-tuned prompt produces on its own, and the one that gets a
 * customer's site classified as spam.
 */
export const keywordStuffedArticle: ArticleQualityInput = {
  ...goodArticle,
  title: "Deposit Deduction Rules: Deposit Deduction Advice for Every Deposit Deduction",
  blocks: [
    {
      type: "text",
      id: "intro",
      data: {
        content: `<p>A deposit deduction is a deposit deduction, and every deposit deduction
        follows deposit deduction rules. Our deposit deduction guide covers deposit deduction
        evidence, deposit deduction disputes and deposit deduction timelines. Read the
        <a href="/guides/check-in-inventory-report-guide">deposit deduction inventory guide</a>
        for more deposit deduction detail.</p>`,
      },
    },
    {
      type: "heading",
      id: "h2-1",
      data: { text: "Deposit Deduction Basics for Deposit Deduction Claims", level: 2 },
    },
    {
      type: "text",
      id: "s1",
      data: {
        content: `<p>Deposit deduction claims need deposit deduction evidence. A deposit
        deduction without deposit deduction proof is a deposit deduction that fails. See the
        <a href="/guides/fair-wear-and-tear-explained">deposit deduction wear guide</a> and the
        <a href="/guides/tenancy-deposit-protection-schemes">deposit deduction scheme guide</a>
        for deposit deduction context.</p>`,
      },
    },
    { type: "faq", id: "faq", data: { items: FAQ_ITEMS } },
  ],
  targetWordCount: { min: 80, max: 900 },
};

/**
 * Reads well and would sail past a human skim, but the percentage, the survey
 * figure and the named body appear nowhere in the source. This is the defect
 * the engine's prompts forbid and nothing downstream currently verifies.
 */
export const fabricatedStatArticle: ArticleQualityInput = {
  ...goodArticle,
  blocks: [
    {
      type: "text",
      id: "intro",
      data: {
        content: `<p>A deposit deduction is a claim against your money, not a fee. Studies show
        that 68% of tenants accept the first figure they are given, and according to the
        National Renters Institute the average unchallenged deduction runs to £1,240 per
        tenancy. Start with the
        <a href="/guides/check-in-inventory-report-guide">check-in inventory report</a>.</p>`,
      },
    },
    {
      type: "heading",
      id: "h2-1",
      data: { text: "What Counts as a Fair Deposit Deduction?", level: 2 },
    },
    { type: "text", id: "s1", data: { content: SECTION_ONE_HTML } },
    {
      type: "heading",
      id: "h2-2",
      data: { text: "How to Challenge a Claim Against Your Deposit", level: 2 },
    },
    { type: "text", id: "s2", data: { content: SECTION_TWO_HTML } },
    { type: "faq", id: "faq", data: { items: FAQ_ITEMS } },
  ],
};

/**
 * The article is fine; the JSON-LD is not. `</script>` inside a string closes
 * the tag early, so the browser and every crawler see truncated markup and a
 * page full of stray text — a silent, total loss of structured data.
 */
export const brokenSchemaArticle: ArticleQualityInput = {
  ...goodArticle,
  structuredData: JSON.stringify([
    {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: "Deposit Deduction Rules: What Can a Landlord Legally Withhold?",
      description: 'A deposit deduction explained. </script><script>alert("x")</script>',
      author: { "@type": "Person", name: "Octypo Editorial" },
      datePublished: "2026-08-01T09:00:00.000Z",
    },
  ]),
};

/** Valid JSON-LD, but the Article entry is missing fields Google requires. */
export const incompleteSchemaArticle: ArticleQualityInput = {
  ...goodArticle,
  structuredData: [{ "@context": "https://schema.org", "@type": "Article" }],
};

/** Has visible FAQs and current Article-only markup. */
export const missingFaqSchemaArticle: ArticleQualityInput = {
  ...goodArticle,
  structuredData: [
    {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: "Deposit Deduction Rules: What Can a Landlord Legally Withhold?",
      description: "A deposit deduction has to be evidenced.",
      image: [HERO],
      datePublished: "2026-08-01T09:00:00.000Z",
      author: { "@type": "Person", name: "Octypo Editorial" },
      publisher: { "@type": "Organization", name: "Octypo" },
    },
  ],
};
