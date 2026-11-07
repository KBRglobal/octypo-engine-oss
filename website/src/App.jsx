import { ArrowDown, ArrowRight, Check, Copy, Menu, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";

const faqs = [
  {
    q: "What does Octypo actually do?",
    a: "It reads the sources you trust, decides which stories are worth telling, writes each one with the specialist writer that suits it, checks the facts against the sources, and hands you a publication-ready article. You approve before anything goes out.",
  },
  {
    q: "Is the writing original?",
    a: "Yes. Octypo does not rewrite one article into another. It reads across your sources, forms the story itself, and writes it from scratch in the voice you set.",
  },
  {
    q: "Who checks it before it is published?",
    a: "Octypo checks every claim against the sources it used and refuses to publish one it cannot support. A person still approves the article, because a newsroom without an editor is not a newsroom.",
  },
  {
    q: "Where do the articles end up?",
    a: "Wherever you publish. Octypo hands over finished articles through its API, so they can go into your own site, your CMS, or a static build.",
  },
  {
    q: "How many articles can it produce?",
    a: "From thirty a month to three hundred, depending on the plan. The limit is deliberate: volume without a source library produces noise, and noise is what we are trying to remove.",
  },
  {
    q: "Is Octypo open source?",
    a: "Yes. The engine is free under the MIT license. You run it on your own server with your own model keys, and you pay only your model provider. The paid plans are for teams that would rather work with us.",
  },
  {
    q: "Who is behind Octypo?",
    a: "KBR Global Creative Consulting Ltd, a creative and engineering studio registered in Gibraltar. Octypo is the engine we built for our own editorial work and then opened to others.",
  },
];

const REPO_URL = "https://github.com/KBRglobal/octypo-engine-oss";
const INSTALL_COMMAND = "npm install -g octypo";

const steps = [
  {
    number: "01",
    label: "Find the signal",
    title: "It reads everything. It chooses what matters.",
    body: "Octypo watches your trusted feeds and source library, filters out the noise, and finds stories with real search and audience potential.",
    image: "/assets/select-story.png",
  },
  {
    number: "02",
    label: "Shape the story",
    title: "The right writer for every assignment.",
    body: "Eight specialist voices turn each idea into an original, structured article — from breaking news and analysis to guides and deep dives.",
    image: "/assets/write-story.png",
  },
  {
    number: "03",
    label: "Pass the desk",
    title: "Every article earns its way out.",
    body: "A second editorial layer checks quality, structure, facts, duplication, SEO and answer-readiness before anything is approved.",
    image: "/assets/quality-gate.png",
  },
  {
    number: "04",
    label: "Publish at scale",
    title: "A newsroom that never misses a beat.",
    body: "Approved stories arrive publication-ready with metadata, imagery, FAQs, internal links and structured data already in place.",
    image: "/assets/publish-scale.png",
  },
];

const features = [
  ["Multi-model by design", "Claude, OpenAI, Gemini and Groq work as one resilient editorial team."],
  ["Your domain, not ours", "Topics, standards and voice adapt to the world your brand actually lives in."],
  ["Built-in quality gates", "Every story is selected, written, checked, revised and approved through a bounded process."],
  ["Search-ready output", "Metadata, answer capsules, FAQs, schema and internal linking arrive with every article."],
];

export function Logo() {
  return (
    <a className="logo" href="#top" aria-label="Octypo home">
      <span className="logo-word">Octypo</span>
    </a>
  );
}

function InstallCommand() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused; the command stays selectable by hand.
    }
  }

  return (
    <div className="install-command">
      <code>{INSTALL_COMMAND}</code>
      <button type="button" onClick={copy} aria-label={copied ? "Copied" : "Copy install command"}>
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </button>
    </div>
  );
}

function HeroMotion() {
  return (
    <video className="hero-motion" autoPlay muted playsInline poster="/assets/octypo-hero.png" aria-hidden="true">
      <source src="/assets/octypo-hero-alive-30s.mp4" type="video/mp4" />
    </video>
  );
}

function App() {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => entries.forEach((entry) => entry.isIntersecting && entry.target.classList.add("is-visible")),
      { threshold: 0.14 },
    );
    document.querySelectorAll(".reveal").forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, []);

  return (
    <main id="top">
      <header className="nav-shell">
        <nav className="nav">
          <Logo />
          <div className={`nav-links ${menuOpen ? "open" : ""}`}>
            <a href="#how" onClick={() => setMenuOpen(false)}>How it works</a>
            <a href="#engine" onClick={() => setMenuOpen(false)}>The engine</a>
            <a href="#proof" onClick={() => setMenuOpen(false)}>Proof</a>
            <a href="#pricing" onClick={() => setMenuOpen(false)}>Pricing</a>
            <a href="#open-source" onClick={() => setMenuOpen(false)}>Open source</a>
            <a className="nav-cta" href="#contact" onClick={() => setMenuOpen(false)}>Book a demo <ArrowRight size={15} /></a>
          </div>
          <button className="menu-button" onClick={() => setMenuOpen((open) => !open)} aria-label="Toggle navigation">
            {menuOpen ? <X /> : <Menu />}
          </button>
        </nav>
      </header>

      <section className="hero">
        <div className="hero-image" role="img" aria-label="Octypo autonomous editorial studio" />
        <HeroMotion />
        <div className="hero-shade" />
        <div className="hero-content">
          <div className="eyebrow"><Sparkles size={14} /> Autonomous editorial engine</div>
          <h1>Your best stories.<br /><em>Already written.</em></h1>
          <p>Octypo turns trusted sources into original, publication-ready articles — selected, written, checked and delivered autonomously.</p>
          <div className="hero-actions">
            <a className="button button-light" href="#contact">Book a demo <ArrowRight size={18} /></a>
            <a className="text-link" href="#how">See the newsroom <ArrowDown size={18} /></a>
          </div>
          <div className="hero-open-source">
            <a href="#open-source">Free and open source</a>
            <InstallCommand />
          </div>
        </div>
        <div className="hero-stamp"><span>4,731</span> articles published<br />in the real world</div>
      </section>

      <section className="intro reveal" id="proof">
        <div className="intro-copy-block">
          <p className="section-kicker light">Not another writing tool</p>
          <h2>Give it the sources.<br /><em>Get the publication.</em></h2>
          <p className="intro-copy">Octypo is the working editorial layer between information and a growing content library. It makes decisions, keeps standards high and moves every strong story all the way to published.</p>
        </div>
        <div className="proof-film" aria-label="Octypo publishing statistics">
          <video autoPlay muted loop playsInline aria-hidden="true">
            <source src="/assets/octypo-alive-part-3.mp4" type="video/mp4" />
          </video>
          <div className="proof-film-caption"><strong>4,731</strong><span>articles already published</span></div>
          <div className="proof-film-stats"><span><b>8</b> writers</span><span><b>2</b> quality gates</span><span><b>24/7</b> operation</span></div>
        </div>
        <div className="source-ticker" aria-hidden="true">
          <div>RESEARCH REPORTS <i /> TRUSTED FEEDS <i /> INTERNAL KNOWLEDGE <i /> INDUSTRY NEWS <i /> ORIGINAL ANALYSIS <i /> RESEARCH REPORTS <i /> TRUSTED FEEDS <i /> INTERNAL KNOWLEDGE <i /></div>
        </div>
      </section>

      <section className="process" id="how">
        <div className="process-heading reveal">
          <p className="section-kicker">Inside the newsroom</p>
          <h2>From a sea of sources<br />to one story worth reading.</h2>
        </div>
        {steps.map((step, index) => (
          <article className={`process-step reveal ${index % 2 ? "reverse" : ""}`} key={step.number}>
            <div className="step-image-wrap">
              <img src={step.image} alt="" loading="lazy" />
              <span className="image-number">{step.number}</span>
            </div>
            <div className="step-copy">
              <span className="step-label">{step.label}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
              <div className="step-rule"><span /></div>
            </div>
          </article>
        ))}
      </section>

      <section className="library reveal">
        <img src="/assets/document-library.png" alt="A rich library of source material organized by Octypo" loading="lazy" />
        <video className="library-documents-motion" autoPlay muted loop playsInline aria-hidden="true">
          <source src="/assets/archive-documents.webm" type="video/webm" />
        </video>
        <div className="library-copy">
          <p className="section-kicker light">Your knowledge, multiplied</p>
          <h2>There are stories hiding in your archive.</h2>
          <p>Upload research, reports, PDFs and internal knowledge. Octypo finds the strongest angles and turns dormant material into an active publishing pipeline.</p>
          <a className="button button-coral" href="#contact">Open your library <ArrowRight size={18} /></a>
        </div>
      </section>

      <div className="lower-flow">
      <section className="engine" id="engine">
        <div className="engine-layout">
          <div className="engine-heading reveal">
            <p className="section-kicker">Quietly sophisticated</p>
            <h2>Autonomous doesn’t mean unchecked.</h2>
            <p>The machinery stays out of the way. The standards never do.</p>
          </div>
          <div className="engine-visual reveal">
            <video autoPlay muted loop playsInline aria-hidden="true">
              <source src="/assets/octypo-alive-part-2.mp4" type="video/mp4" />
            </video>
            <div className="engine-orbit" aria-hidden="true" />
            <div className="feature-stack">
              {features.map(([title, body], index) => (
                <article className="feature" key={title}>
                  <span>0{index + 1}</span>
                  <div><h3>{title}</h3><p>{body}</p></div>
                  <Check size={18} />
                </article>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="pricing" id="pricing">
        <div className="pricing-heading">
          <p className="section-kicker light">Simple monthly pricing</p>
          <h2>Choose your publishing pace.</h2>
          <p>Everything you need to turn trusted sources into a consistent editorial pipeline.</p>
        </div>
        <div className="pricing-grid">
          {[
            ["The Brief", "30", "89"],
            ["The Desk", "100", "289"],
            ["The Newsroom", "300", "799"],
          ].map(([name, articles, price]) => (
            <article className="price-card" key={articles}>
              <span className="price-name">{name}</span>
              <span className="price-volume">{articles} articles per month</span>
              <div className="price"><sup>€</sup>{price}<small>/month</small></div>
              <p>Publication-ready articles every month.</p>
              <a className="button button-light" href="#contact">Book a demo <ArrowRight size={18} /></a>
            </article>
          ))}
        </div>
        <article className="open-source-plan" id="open-source">
          <div>
            <span className="price-name">Open source</span>
            <span className="price-volume">Free · Self-hosted · MIT license</span>
            <p>Run the engine on your own server with your own model keys. You pay only your model provider.</p>
          </div>
          <div className="open-source-actions">
            <InstallCommand />
            <a className="button button-light" href={REPO_URL} target="_blank" rel="noopener noreferrer">View on GitHub <ArrowRight size={18} /></a>
          </div>
        </article>
      </section>

      <section className="faq" id="faq">
        <div className="pricing-heading">
          <p className="section-kicker light">Questions</p>
          <h2>What people ask before a demo.</h2>
        </div>
        <dl className="faq-list">
          {faqs.map((item) => (
            <div className="faq-item" key={item.q}>
              <dt>{item.q}</dt>
              <dd>{item.a}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="manifesto reveal">
        <div className="manifesto-word">OCTYPO</div>
        <p>One engine. Eight arms. Every story moving forward.</p>
      </section>

      <section className="contact" id="contact">
        <div className="contact-orbit" aria-hidden="true"><i /><i /><i /></div>
        <p className="section-kicker light">Your next issue starts here</p>
        <h2>Build a newsroom<br />that keeps moving.</h2>
        <p>See Octypo turn your own sources into publication-ready content.</p>
        <a className="button button-light" href="mailto:info@kbr.global">Book a demo <ArrowRight size={18} /></a>
      </section>

      <footer>
        <Logo />
        <p>Autonomous editorial intelligence.</p>
        <span>© {new Date().getFullYear()} Octypo, a product of KBR Global Creative Consulting Ltd, Gibraltar</span>
        <nav className="footer-legal" aria-label="Legal">
          <a href="/privacy/">Privacy</a>
          <a href="/terms/">Terms</a>
          <a href="/cookies/">Cookies</a>
          <a href="/about/">About</a>
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
        </nav>
        <span className="kbr-credit"><span>Web Design, SEO &amp; Managed Hosting by</span><a href="https://kbr.global" target="_blank" rel="noopener noreferrer" aria-label="KBR Global"><img src="/brand/kbr-logo.png" alt="" /><strong>KBR Global</strong></a></span>
      </footer>
      </div>
    </main>
  );
}

export default App;
