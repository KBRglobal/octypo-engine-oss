// Shared shell + content for the legal pages (/privacy, /terms, /cookies, /about).
// Each page is prerendered to its own static file by scripts/prerender.mjs — no
// client-side router, because none of these pages needs one.
import { Logo } from "./App";

export const ENTITY = "KBR Global Creative Consulting Ltd";
export const ENTITY_ADDRESS = "Suite 4.3.02, Block 4, Eurotowers, Gibraltar GX11 1AA";
export const ENTITY_NUMBER = "125571";
export const ENTITY_DUNS = "855019981";
export const CONTACT = "info@kbr.global";
export const UPDATED = "2026-09-10";

function LegalShell({ title, children }) {
  return (
    <main id="top" className="legal-page">
      <header className="nav-shell">
        <nav className="nav">
          <Logo />
          <a className="nav-cta" href="/">Back to Octypo</a>
        </nav>
      </header>
      <div className="legal-body">
        <p className="legal-kicker">Legal</p>
        <h1>{title}</h1>
        <p className="legal-updated">Last updated {UPDATED}</p>
        {children}
      </div>
      <footer className="legal-footer">
        <Logo />
        <span className="kbr-credit">
          <a href="https://kbr.global" target="_blank" rel="noopener noreferrer">Web Design, SEO &amp; Managed Hosting by KBR Global</a>
        </span>
        <nav aria-label="Legal">
          <a href="/privacy/">Privacy</a>
          <a href="/terms/">Terms</a>
          <a href="/cookies/">Cookies</a>
          <a href="/about/">About</a>
        </nav>
      </footer>
    </main>
  );
}

export function PrivacyPage() {
  return (
    <LegalShell title="Privacy Policy">
      <p>Octypo is a product of {ENTITY}, a company registered in Gibraltar (company number {ENTITY_NUMBER}) at {ENTITY_ADDRESS} (&quot;Octypo&quot;, &quot;we&quot;).</p>
      <h2>What this site collects</h2>
      <p>octypo.com is a single marketing page. It has no sign-up form, no account system, and no cookies. The only way to reach us from this site is the &quot;Book a demo&quot; link, which opens your own email client addressed to {CONTACT} — nothing is submitted to us through the page itself.</p>
      <h2>The Octypo product</h2>
      <p>Once a client is onboarded, Octypo reads the source material they give it (documents, feeds, an existing site) and writes articles from it. Client source material and published output are stored on our infrastructure to run the service, and are not used to train models or shared with anyone beyond the providers named below.</p>
      <h2>Who else handles it</h2>
      <ul>
        <li><strong>Railway</strong> — application hosting and the database.</li>
        <li><strong>Cloudflare</strong> — this website and its assets.</li>
        <li><strong>Anthropic, OpenAI, Google, Groq</strong> — the language models that draft and check articles.</li>
      </ul>
      <p>We do not sell personal information and do not use it for advertising.</p>
      <h2>Your rights</h2>
      <p>To ask what we hold, request a copy, correct it, or have it deleted, write to <a href={`mailto:${CONTACT}`}>{CONTACT}</a>. We reply to every message.</p>
      <h2>Contact</h2>
      <p>{ENTITY}, {ENTITY_ADDRESS}. <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.</p>
    </LegalShell>
  );
}

export function TermsPage() {
  return (
    <LegalShell title="Terms of Service">
      <p>These terms govern use of Octypo, a service of {ENTITY}. Using the service accepts them.</p>
      <h2>1. What Octypo is</h2>
      <p>Octypo reads the sources a client gives it, drafts original articles, checks each claim against those sources, and hands over publication-ready content. A person at the client approves every article before it goes anywhere. <strong>Octypo is not a licensed publisher, a fact-checking authority, or a substitute for editorial judgment.</strong></p>
      <h2>2. Plans and payment</h2>
      <p>Plans are billed monthly at the price shown on this page at the time of purchase, in EUR. Fees are charged in advance and are not refundable except where the law requires it. We may change prices with at least 30 days&apos; notice.</p>
      <h2>3. Your content</h2>
      <p>You own the source material you give us and the articles Octypo produces from it. We use your content only to run the service for you.</p>
      <h2>4. AI output</h2>
      <p>Octypo&apos;s output is checked against the sources you provide, but it can still be wrong. You are responsible for reviewing and approving an article before it is published anywhere.</p>
      <h2>5. Acceptable use</h2>
      <p>Do not use Octypo to generate content that is defamatory, infringing, or illegal, or to impersonate a person or organisation without disclosure.</p>
      <h2>6. Liability</h2>
      <p>To the maximum extent the law allows, our total liability in any twelve-month period is capped at what you paid us in that period. Nothing here limits liability that cannot lawfully be limited.</p>
      <h2>7. Contact</h2>
      <p>{ENTITY}, {ENTITY_ADDRESS}. <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.</p>
    </LegalShell>
  );
}

export function CookiesPage() {
  return (
    <LegalShell title="Cookie Policy">
      <p>octypo.com sets no cookies — no tracking, no advertising, no analytics. There is no cookie banner because there is nothing here to ask permission for.</p>
      <h2>What loads when you visit</h2>
      <p>The page itself, its stylesheet, two short muted background videos, and images — all served from octypo.com or its own asset storage. No third-party script, font, or tracking pixel loads from this page.</p>
      <h2>Contact</h2>
      <p>{ENTITY}, {ENTITY_ADDRESS}. <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.</p>
    </LegalShell>
  );
}

export function AboutPage() {
  return (
    <LegalShell title="About Octypo">
      <p>Octypo is an autonomous editorial engine: it reads the sources you trust, chooses the stories worth telling, writes them with a newsroom of specialist AI writers, checks every claim, and hands you publication-ready articles.</p>
      <p>Octypo is built and operated by {ENTITY}, a creative and engineering studio registered in Gibraltar (company number {ENTITY_NUMBER}, DUNS {ENTITY_DUNS}). Octypo started as the engine behind our own editorial work and is now offered to other publishers and brands.</p>
      <h2>Contact</h2>
      <p>{ENTITY}, {ENTITY_ADDRESS}. <a href={`mailto:${CONTACT}`}>{CONTACT}</a>. General enquiries about KBR Global: <a href="mailto:info@kbr.global">info@kbr.global</a>.</p>
    </LegalShell>
  );
}
