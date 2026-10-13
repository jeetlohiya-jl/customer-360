#!/usr/bin/env node
// Fails if any server-only secret ends up in files served to browsers.
// Run after `npm run build`. In CI, server-only variables are set to unique
// sentinel strings, so a leak of the value (not just the name) is detected.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const CLIENT_DIR = join(process.cwd(), ".next", "static");
const SERVER_ONLY_NAMES = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "DATABASE_URL",
  "TOKEN_ENCRYPTION_KEY",
  "GOOGLE_GMAIL_CLIENT_SECRET",
  "WORKER_SHARED_SECRET",
  "WORKER_DATABASE_URL",
  "CRON_SECRET",
];

if (!existsSync(CLIENT_DIR)) {
  console.error("No .next/static directory. Run `npm run build` first.");
  process.exit(2);
}

const needles = [];
for (const name of SERVER_ONLY_NAMES) {
  needles.push({ label: `variable name ${name}`, text: name });
  const value = process.env[name];
  if (value && value.length >= 12) needles.push({ label: `value of ${name}`, text: value });
}

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = walk(CLIENT_DIR).filter((f) => /\.(js|css|html|json|map|txt)$/.test(f));
const hits = [];
for (const file of files) {
  const content = readFileSync(file, "utf8");
  for (const n of needles) if (content.includes(n.text)) hits.push(`${n.label} found in ${file}`);
}

if (hits.length) {
  console.error("Server-only data found in client bundle:\n" + hits.map((h) => `  - ${h}`).join("\n"));
  process.exit(1);
}
const valueChecks = needles.filter((n) => n.label.startsWith("value")).length;
console.log(`Client bundle clean: ${files.length} files scanned, ${needles.length} patterns (${valueChecks} secret values).`);
