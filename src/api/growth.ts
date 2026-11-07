import { Router } from "express";
import { bankSummary } from "../research/bank-store.js";
import { growthControllerStatus, runGrowthCycle } from "../research/growth-controller.js";

export const growthRouter = Router();

growthRouter.get("/", async (_req, res) => {
  res.json({ ...growthControllerStatus(), bank: await bankSummary() });
});

growthRouter.post("/run", async (_req, res) => {
  try {
    res.json(await runGrowthCycle());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Growth cycle failed" });
  }
});
