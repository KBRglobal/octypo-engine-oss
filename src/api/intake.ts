/**
 * Client questionnaire — a public page the business owner fills on a phone,
 * whose answers become confirmed facts for the writer.
 *
 *   GET  /q/:token          the form (server-rendered, no build step)
 *   POST /api/intake/:token  { answers: { <questionId>: "<text>" } }
 *
 * The token is the install's INTAKE_TOKEN (a long random string the owner
 * shares as a link); without it the routes answer 404 so the engine's public
 * surface does not advertise the feature. A re-submit replaces the facts of
 * the questions answered again (matched by source) and leaves the rest.
 *
 * The page is English by default. SITE_LANGUAGE sets its `lang` and text
 * direction; an install that serves another language also sets its words with
 * INTAKE_COPY and its questions with INTAKE_QUESTIONS_JSON.
 */
import { Router, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db.js";
import { clusterFacts } from "../schema/index.js";
import { logger } from "../lib/logger.js";
import { SITE_NAME } from "../config/domain.js";
import { answersToFacts, loadSections, questionCount, type Section } from "../intake/questions.js";
import { textDirection } from "../publishing/text-direction.js";

/** `{part}`, `{parts}`, `{answered}` and `{total}` are filled in where they appear. */
const DEFAULT_COPY = {
  title: "Content questionnaire",
  lead: "Your answers are the material the site's articles are written from: only facts you have approved, nothing invented. A number or a range beats a description. You do not have to answer everything, and every answer is saved right away.",
  progress: "Part {part} of {parts}",
  answered: "{answered} of {total} answered",
  previous: "Back",
  next: "Next",
  submit: "Send",
  saving: "Saving…",
  saveFailed: "Not saved, please try again",
  doneTitle: "Thank you, it is saved.",
  doneBody: "You can come back to this link at any time to correct or add to your answers. Every change reaches us right away.",
};

type IntakeCopy = typeof DEFAULT_COPY;

function intakeCopy(): IntakeCopy {
  try {
    const parsed = JSON.parse(process.env.INTAKE_COPY ?? "{}") as Partial<IntakeCopy>;
    return { ...DEFAULT_COPY, ...Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === "string")) };
  } catch {
    return DEFAULT_COPY;
  }
}

/** A value that is safe as an HTML attribute; anything else is not a language tag. */
function siteLanguage(): string {
  const raw = process.env.SITE_LANGUAGE?.trim() ?? "";
  return /^[A-Za-z0-9-]+$/.test(raw) ? raw : "en";
}

function tokenOk(provided: string): boolean {
  const expected = process.env.INTAKE_TOKEN?.trim() ?? "";
  if (expected.length < 16 || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

function brand(): { accent: string; background: string; surface: string; text: string; muted: string; fontBody: string; fontHeading: string; radius: string } {
  const defaults = {
    accent: "#ff463d",
    background: "#050608",
    surface: "#0f1114",
    text: "#ffffff",
    muted: "#a8a8a8",
    fontBody: "system-ui, sans-serif",
    fontHeading: "system-ui, sans-serif",
    radius: "16px",
  };
  try {
    const parsed = JSON.parse(process.env.OCTYPO_BRAND ?? "{}") as Partial<typeof defaults>;
    return { ...defaults, ...Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === "string" && /^[#\w\s,().%-]+$/.test(v))) };
  } catch {
    return defaults;
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderQuestionnaire(sections: Section[], token: string, businessName: string, answered: Record<string, string>): string {
  const b = brand();
  const copy = intakeCopy();
  const language = siteLanguage();
  const total = questionCount(sections);
  const field = (id: string, type: string, hint?: string) => {
    const value = esc(answered[id] ?? "");
    const attrs = `id="${id}" name="${id}" data-q autocomplete="off"`;
    if (type === "long") return `<textarea ${attrs} rows="3" placeholder="${esc(hint ?? "")}">${value}</textarea>`;
    return `<input ${attrs} type="text" inputmode="${type === "number" ? "decimal" : "text"}" value="${value}" placeholder="${esc(hint ?? "")}">`;
  };
  const answeredLabel = (n: number) => copy.answered.replace("{answered}", String(n)).replace("{total}", String(total));
  // Operator text inside a <script>: "<" must not be able to close the element.
  const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
  const sectionsHtml = sections
    .map(
      (s, i) => `
    <section class="step" data-step="${i}" ${i === 0 ? "" : "hidden"}>
      <p class="kicker">${esc(copy.progress.replace("{part}", String(i + 1)).replace("{parts}", String(sections.length)))}</p>
      <h2>${esc(s.title)}</h2>
      ${s.intro ? `<p class="intro">${esc(s.intro)}</p>` : ""}
      ${s.questions.map((qq) => `<label class="q"><span>${esc(qq.label)}</span>${field(qq.id, qq.type, qq.hint)}</label>`).join("")}
    </section>`
    )
    .join("");
  return `<!doctype html>
<html lang="${language}" dir="${textDirection(language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(copy.title)} · ${esc(businessName)}</title>
<style>
  :root{--accent:${b.accent};--bg:${b.background};--surface:${b.surface};--text:${b.text};--muted:${b.muted};--radius:${b.radius}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font-family:${b.fontBody};line-height:1.55}
  main{max-width:720px;margin:0 auto;padding:28px 18px 120px}
  h1{font-family:${b.fontHeading};font-weight:400;font-size:clamp(28px,6vw,40px);margin:0 0 6px;letter-spacing:.2px}
  h2{font-family:${b.fontHeading};font-weight:400;font-size:24px;margin:6px 0 4px}
  .lead{color:var(--muted);margin:0 0 22px;font-size:16px}
  .kicker{color:var(--accent);font-weight:700;font-size:12px;letter-spacing:.08em;margin:0}
  .intro{color:var(--muted);margin:0 0 14px}
  .bar{height:6px;background:#1c1f24;border-radius:999px;overflow:hidden;margin:0 0 22px}
  .bar i{display:block;height:100%;width:0;background:var(--accent);transition:width .3s}
  .q{display:block;background:var(--surface);border:1px solid #1e2126;border-radius:var(--radius);padding:14px 14px 12px;margin:0 0 12px}
  .q span{display:block;font-weight:600;margin-bottom:8px}
  input,textarea{width:100%;border:1px solid #2a2e35;background:#0a0c0f;color:var(--text);border-radius:calc(var(--radius) - 6px);padding:12px;font:inherit;font-size:16px}
  input:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
  textarea{resize:vertical;min-height:84px}
  .nav{position:fixed;inset-inline:0;bottom:0;background:linear-gradient(to top,var(--bg) 70%,transparent);padding:14px 18px 22px}
  .nav div{max-width:720px;margin:0 auto;display:flex;gap:10px;justify-content:space-between;align-items:center}
  button{font:inherit;font-weight:700;font-size:16px;border:0;border-radius:999px;padding:14px 22px;cursor:pointer;min-height:48px}
  .primary{background:var(--accent);color:#fff}
  .ghost{background:transparent;color:var(--muted);border:1px solid #2a2e35}
  .status{color:var(--muted);font-size:13px;flex:1;text-align:center}
  .done{text-align:center;padding:60px 10px}
  .done h2{font-size:32px}
  .done p{color:var(--muted)}
  @media (min-width:720px){.q{padding:18px}}
</style>
</head>
<body>
<main>
  <p class="kicker">${esc(businessName)}</p>
  <h1>${esc(copy.title)}</h1>
  <p class="lead">${esc(copy.lead)}</p>
  <div class="bar"><i id="bar"></i></div>
  <form id="f" novalidate>
    ${sectionsHtml}
    <section class="step done" data-step="${sections.length}" hidden>
      <h2>${esc(copy.doneTitle)}</h2>
      <p>${esc(copy.doneBody)}</p>
    </section>
  </form>
</main>
<div class="nav"><div>
  <button type="button" class="ghost" id="prev">${esc(copy.previous)}</button>
  <span class="status" id="status">${esc(answeredLabel(0))}</span>
  <button type="button" class="primary" id="next">${esc(copy.next)}</button>
</div></div>
<script>
(function(){
  var token=${scriptJson(token)};
  var copy=${scriptJson({ next: copy.next, submit: copy.submit, saving: copy.saving, saveFailed: copy.saveFailed, answered: copy.answered })};
  function answeredLabel(n){return copy.answered.replace('{answered}',n).replace('{total}',total)}
  var steps=[].slice.call(document.querySelectorAll('.step'));
  var total=${total};var cur=0;var dirty={};var timer=null;
  var fields=[].slice.call(document.querySelectorAll('[data-q]'));
  function answered(){return fields.filter(function(f){return f.value.trim().length>=2}).length}
  function paint(){
    steps.forEach(function(s,i){s.hidden=i!==cur});
    document.getElementById('bar').style.width=Math.round(100*Math.min(cur,steps.length-1)/(steps.length-1))+'%';
    document.getElementById('prev').style.visibility=cur===0?'hidden':'visible';
    var next=document.getElementById('next');
    next.textContent=cur>=steps.length-2?copy.submit:copy.next;
    next.style.display=cur===steps.length-1?'none':'';
    document.getElementById('status').textContent=answeredLabel(answered());
    window.scrollTo({top:0,behavior:'smooth'});
  }
  function collect(){var a={};fields.forEach(function(f){if(f.value.trim())a[f.name]=f.value.trim()});return a}
  var saving=false;
  function save(cb){
    var body=JSON.stringify({answers:collect()});
    saving=true;document.getElementById('status').textContent=copy.saving;
    fetch('/api/intake/'+encodeURIComponent(token),{method:'POST',headers:{'content-type':'application/json'},body:body})
      .then(function(r){return r.ok?r.json():Promise.reject(r.status)})
      .then(function(){saving=false;paint();if(cb)cb(true)})
      .catch(function(){saving=false;document.getElementById('status').textContent=copy.saveFailed;if(cb)cb(false)});
  }
  fields.forEach(function(f){f.addEventListener('input',function(){clearTimeout(timer);timer=setTimeout(function(){save()},1500)})});
  document.getElementById('next').addEventListener('click',function(){clearTimeout(timer);save(function(ok){if(ok||cur<steps.length-2){cur=Math.min(cur+1,steps.length-1);paint()}})});
  document.getElementById('prev').addEventListener('click',function(){cur=Math.max(cur-1,0);paint()});
  paint();
})();
</script>
</body>
</html>`;
}

export function createIntakeRouter(): Router {
  const router = Router();

  router.get("/q/:token", async (req: Request, res: Response) => {
    if (!tokenOk(String(req.params.token))) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    const sections = loadSections();
    // Pre-fill from the facts already stored by earlier submissions.
    const rows = await db
      .select({ fact: clusterFacts.fact, source: clusterFacts.source })
      .from(clusterFacts)
      .where(inArray(clusterFacts.source, sections.flatMap((s) => s.questions.map((q) => `questionnaire:${q.id}`))));
    const answered: Record<string, string> = {};
    for (const row of rows) {
      const id = row.source.replace(/^questionnaire:/, "");
      const subject = sections.flatMap((s) => s.questions).find((q) => q.id === id)?.fact;
      answered[id] = subject && row.fact.startsWith(subject + ": ") ? row.fact.slice(subject.length + 2) : row.fact;
    }
    res.type("text/html").send(renderQuestionnaire(sections, String(req.params.token), SITE_NAME, answered));
  });

  router.post("/api/intake/:token", async (req: Request, res: Response) => {
    if (!tokenOk(String(req.params.token))) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const answers = (req.body?.answers ?? {}) as Record<string, unknown>;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
      res.status(400).json({ error: "answers must be an object" });
      return;
    }
    const sections = loadSections();
    const facts = answersToFacts(answers, sections);
    // Replace only the questions answered in this submission; keep the rest.
    const sources = facts.map((f) => f.source);
    try {
      if (sources.length) {
        await db.delete(clusterFacts).where(and(inArray(clusterFacts.source, sources), eq(clusterFacts.confirmed, true)));
        await db.insert(clusterFacts).values(facts.map((f) => ({ cluster: f.cluster, fact: f.fact, confirmed: true, source: f.source })));
      }
      logger.info({ saved: facts.length, questions: sources }, "[Intake] Questionnaire answers saved as facts");
      res.json({ saved: facts.length });
    } catch (error) {
      logger.error({ error }, "[Intake] Failed to save questionnaire answers");
      res.status(500).json({ error: "Failed to save" });
    }
  });

  return router;
}
