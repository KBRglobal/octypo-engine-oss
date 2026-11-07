/**
 * The client-facing view of a prospect report.
 *
 * Deliberately outside the admin router and outside `requireAdmin`: the person
 * who opens it is the prospect, and the only credential is the unguessable
 * token in the link. The page declares noindex, and the document itself is
 * served exactly as it was stored — the numbers in it were true on the date it
 * carries, and re-running them on view would quietly rewrite what we sent.
 */

import { Router } from "express";

import { logger } from "../lib/logger.js";
import { renderProspectReport } from "../seo/report-html.js";
import type { ProspectReport } from "../seo/report.js";

export const seoReportPageRouter = Router();

seoReportPageRouter.get("/r/:token", async (req, res) => {
  const token = req.params.token;
  // The token is the whole credential, so a malformed one is not looked up.
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(token)) {
    res.status(404).type("text/plain").send("Not found");
    return;
  }

  try {
    const { db } = await import("../db.js");
    const { seoReports } = await import("../schema/index.js");
    const { eq } = await import("drizzle-orm");

    const [row] = await db.select().from(seoReports).where(eq(seoReports.token, token)).limit(1);
    if (!row) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }

    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    // The engine denies framing everywhere, which is right for the admin. This
    // one page is a public, read-only document with no actions and no session,
    // and the operator previews it inside the desk before sending — so same
    // origin is allowed here, and only here.
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.type("html").send(renderProspectReport(row.payload as unknown as ProspectReport));
  } catch (error) {
    logger.error({ error, token }, "[SEO] Could not serve a prospect report");
    res.status(500).type("text/plain").send("Report unavailable");
  }
});
