#!/usr/bin/env node
/** Copy the non-TypeScript files the compiled engine reads at runtime. */
import { copyFileSync } from "node:fs";

copyFileSync("src/writer/commercial-prompt.txt", "dist/writer/commercial-prompt.txt");
