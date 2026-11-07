import { Router } from "express";
import { SITE_URL } from "../config/domain.js";
import { latestOctyGateReport, runOctyGate } from "../octygate/runner.js";
import { octyGateStatus } from "../octygate/scheduler.js";

export const octyGateRouter = Router();

octyGateRouter.get("/", async (_req, res) => res.json({ ...octyGateStatus(), report: await latestOctyGateReport() }));
octyGateRouter.post("/run", async (_req, res) => {
  if (!SITE_URL) return res.status(400).json({ error: "SITE_URL is not configured" });
  try { return res.json(await runOctyGate(SITE_URL)); }
  catch (error) { return res.status(500).json({ error: error instanceof Error ? error.message : "OctyGate patrol failed" }); }
});
