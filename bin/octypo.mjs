#!/usr/bin/env node
/**
 * The octypo command: scaffold a working directory, start the database,
 * apply migrations and run the engine. Everything reads .env from the
 * directory it is run in.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cwd = process.cwd();

const HELP = `octypo <command>

  init      Create .env and docker-compose.yml in this directory
  db        Start the bundled Postgres with Docker
  migrate   Apply database migrations
  start     Run the engine
  doctor    Check that this directory is ready to run
  help      Show this message
`;

function runNode(entry) {
  const file = path.join(root, entry);
  if (!existsSync(file)) {
    console.error(`Missing ${entry}. In a source checkout, run "npm run build" first.`);
    return 1;
  }
  return spawnSync(process.execPath, [file], { stdio: "inherit", cwd }).status ?? 1;
}

function init() {
  const env = path.join(cwd, ".env");
  if (existsSync(env)) {
    console.log("Kept the existing .env");
  } else {
    const template = readFileSync(path.join(root, ".env.example"), "utf8");
    const password = randomBytes(18).toString("base64url");
    const filled = /^ADMIN_PASSWORD=.*$/m.test(template)
      ? template.replace(/^ADMIN_PASSWORD=.*$/m, `ADMIN_PASSWORD=${password}`)
      : `${template}\nADMIN_PASSWORD=${password}\n`;
    writeFileSync(env, filled, { mode: 0o600 });
    console.log("Created .env with a generated admin password");
  }
  const compose = path.join(cwd, "docker-compose.yml");
  if (existsSync(compose)) {
    console.log("Kept the existing docker-compose.yml");
  } else {
    copyFileSync(path.join(root, "docker-compose.yml"), compose);
    console.log("Created docker-compose.yml");
  }
  console.log('\nNext: add one LLM key to .env, then run "octypo db", then "octypo start".');
  return 0;
}

function db() {
  const attempts = [
    ["docker", ["compose", "up", "-d", "db"]],
    ["docker-compose", ["up", "-d", "db"]],
  ];
  for (const [command, args] of attempts) {
    const probe = spawnSync(command, command === "docker" ? ["compose", "version"] : ["version"], { stdio: "ignore" });
    if (probe.status === 0) {
      return spawnSync(command, args, { stdio: "inherit", cwd }).status ?? 1;
    }
  }
  console.error("Docker Compose was not found. Install it, or point DATABASE_URL at your own Postgres.");
  return 1;
}

function doctor() {
  const major = Number(process.versions.node.split(".")[0]);
  const envPath = path.join(cwd, ".env");
  const env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const hasValue = (name) => new RegExp(`^${name}=\\S+`, "m").test(env);
  const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY"];
  const checks = [
    ["Node 20 or newer", major >= 20],
    [".env exists", env.length > 0],
    ["DATABASE_URL is set", hasValue("DATABASE_URL")],
    ["At least one LLM key is set", keys.some(hasValue)],
    ["Engine is built", existsSync(path.join(root, "dist/index.js"))],
  ];
  for (const [label, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  return checks.every(([, ok]) => ok) ? 0 : 1;
}

const commands = {
  init,
  db,
  doctor,
  migrate: () => runNode("dist/scripts/migrate.js"),
  start: () => runNode("dist/index.js"),
  help: () => (console.log(HELP), 0),
};

const command = commands[process.argv[2] ?? "help"];
if (!command) {
  console.error(HELP);
  process.exit(1);
}
process.exit(command());
