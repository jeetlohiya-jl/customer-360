#!/usr/bin/env node
// Starts the production build on a local port and verifies security headers,
// route protection and the health endpoint. Run after `npm run build`.
// No hosted services are contacted: the Supabase URL can point anywhere,
// because unauthenticated requests never reach the database.
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

const PORT = process.env.CHECK_PORT ?? "3999";
const BASE = `http://127.0.0.1:${PORT}`;
const failures = [];
const check = (cond, msg) => (cond ? console.log(`  ok  ${msg}`) : failures.push(msg));

const nextBin = join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
const server = spawn(process.execPath, [nextBin, "start", "-p", PORT, "-H", "127.0.0.1"], {
  env: { ...process.env, NODE_ENV: "production" },
  stdio: ["ignore", "pipe", "pipe"],
  detached: process.platform !== "win32",
  windowsHide: true,
});
const stopServer = () => {
  if (process.platform === "win32") {
    // Kill the server and any child processes it started.
    spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    server.kill("SIGTERM");
  }
};
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
      // A 500 from the health check means configuration failed; stop early.
      if (r.status >= 500) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  // Show only the first error block, not the repeated stack traces.
  const firstError = log.split(/\r?\n/).slice(0, 25).join("\n");
  throw new Error("server did not start correctly. First lines of its log:\n" + firstError);
}

try {
  await waitForServer();

  const health = await fetch(`${BASE}/api/health`);
  const body = await health.json();
  check(health.status === 200 && body.status === "ok", "GET /api/health returns ok");
  check(["on", "off"].includes(body.features?.gmail) && body.features?.slack === "off", "health reports Gmail status and Slack off");
  check(!JSON.stringify(body).match(/key|secret|token|password/i), "health response contains no secrets");
  check((health.headers.get("content-security-policy") ?? "").includes("default-src 'none'"), "API responses carry deny-all CSP");

  const slack = await fetch(`${BASE}/api/slack/events`, { method: "POST", body: '{"type":"url_verification","challenge":"x"}' });
  check(slack.status === 404, "Slack events endpoint is closed while Slack is off");

  const login = await fetch(`${BASE}/login`, { redirect: "manual" });
  const csp = login.headers.get("content-security-policy") ?? "";
  check(login.status === 200, "GET /login renders (200)");
  check(/'nonce-[A-Za-z0-9+/=]{16,}'/.test(csp), "page CSP carries a nonce");
  check(csp.includes("frame-ancestors 'none'") && !csp.includes("'unsafe-inline'"), "page CSP blocks framing and inline scripts");
  for (const h of ["strict-transport-security", "x-content-type-options", "x-frame-options", "referrer-policy", "permissions-policy"]) {
    check(login.headers.has(h), `header ${h} present`);
  }
  check(!login.headers.has("x-powered-by"), "x-powered-by removed");

  const html = await login.text();
  const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  check(scripts.length > 0 && scripts.every((s) => s.includes(`nonce="${nonce}"`)), "every script tag carries the request nonce");

  const login2 = await fetch(`${BASE}/login`, { redirect: "manual" });
  const nonce2 = (login2.headers.get("content-security-policy") ?? "").match(/'nonce-([^']+)'/)?.[1];
  check(nonce && nonce2 && nonce !== nonce2, "nonce changes on every request");

  for (const path of ["/dashboard", "/admin", "/"]) {
    const r = await fetch(`${BASE}${path}`, { redirect: "manual" });
    const loc = r.headers.get("location") ?? "";
    check(r.status >= 300 && r.status < 400 && loc.endsWith("/login"), `GET ${path} without a session redirects to /login`);
  }
} catch (e) {
  failures.push(String(e));
} finally {
  stopServer();
}

if (failures.length) {
  console.error("\nHeader/route checks FAILED:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("\nAll header and route checks passed.");
process.exit(0);
