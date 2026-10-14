import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../..");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe("Stage 3 guards: no new permissions, scanning off by default", () => {
  it("customer code never touches Gmail", () => {
    for (const f of [...files(join(root, "lib/customers")), ...files(join(root, "app/(app)/customers"))]) {
      const src = readFileSync(f, "utf8");
      expect(src, relative(root, f)).not.toMatch(/from ["']@\/lib\/gmail|googleapis\.com/);
    }
  });

  it("the Gmail API is only called from lib/gmail/google.ts", () => {
    const callers = [...files(join(root, "lib")), ...files(join(root, "app"))]
      .filter((f) => /gmail\.googleapis\.com/.test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f).replace(/\\/g, "/"));
    expect(callers).toEqual(["lib/gmail/google.ts"]);
  });

  it("the only background job is the scan route, and it does nothing unless scanning is validly enabled", () => {
    const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"));
    expect(vercel.crons).toEqual([
      { path: "/api/cron/scan", schedule: "* * * * *" },
      { path: "/api/cron/extract", schedule: "* * * * *" }, // no-op (204) unless extraction is validly enabled
    ]);
    const route = readFileSync(join(root, "app/api/cron/scan/route.ts"), "utf8");
    expect(route.indexOf("if (!scan.enabled)")).toBeGreaterThan(-1);
    expect(route.indexOf("if (!scan.enabled)")).toBeLessThan(route.indexOf("runTick("));
    expect(route.indexOf("safeEqual(auth")).toBeLessThan(route.indexOf("runTick("));
  });

  it("the scan route never logs raw errors, messages or settings", () => {
    const route = readFileSync(join(root, "app/api/cron/scan/route.ts"), "utf8");
    const logs = route.match(/console\.(log|info|warn|error)\([^;]*;/g) ?? [];
    expect(logs.length).toBeGreaterThan(0);
    for (const l of logs) {
      expect(l).not.toMatch(/\.message|\.stack|String\(e\)|workerDatabaseUrl|cronSecret|CRON_SECRET|WORKER_DATABASE/);
      expect(l).not.toMatch(/console\.\w+\(e\)/);
    }
  });

  it("the scan migration approves no mailbox and enables no worker login", () => {
    const sql = readFileSync(join(root, "supabase/migrations/20261014000006_header_scan.sql"), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(sql).toContain("values ('scan_allowed_mailboxes', '')");
    expect(sql).toMatch(/create role c360_worker nologin/);
    expect(sql).not.toMatch(/alter role c360_worker[^;]*\blogin\b[^;]*password\s+'/i);
  });

  it("Gmail permission: gmail.metadata by default; gmail.readonly only when GMAIL_CONTENT_ACCESS is exactly on", async () => {
    const google = readFileSync(join(root, "lib/gmail/google.ts"), "utf8");
    expect(google.match(/https:\/\/www\.googleapis\.com\/auth\/gmail\.[a-z]+/g)).toEqual([
      "https://www.googleapis.com/auth/gmail.metadata",
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);
    const { requestedScope } = await import("@/lib/gmail/connection");
    expect(requestedScope({})).toBe("https://www.googleapis.com/auth/gmail.metadata");
    for (const v of ["off", "ON", "yes", "true", " on"]) expect(requestedScope({ GMAIL_CONTENT_ACCESS: v })).toBe("https://www.googleapis.com/auth/gmail.metadata");
    expect(requestedScope({ GMAIL_CONTENT_ACCESS: "on" })).toBe("https://www.googleapis.com/auth/gmail.readonly");
  });

  it("Stage B+C stays off by default; content is fetched only by the extraction route", () => {
    const users = [...files(join(root, "lib")), ...files(join(root, "app"))]
      .filter((f) => /getMessageFull\(/.test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f).replace(/\\/g, "/"))
      .sort();
    expect(users).toEqual(["app/api/cron/extract/route.ts", "lib/gmail/google.ts"]);
    const google = readFileSync(join(root, "lib/gmail/google.ts"), "utf8");
    expect(google).toMatch(/export const GMAIL_SCOPE = "https:\/\/www\.googleapis\.com\/auth\/gmail\.metadata";/);
    const example = readFileSync(join(root, ".env.example"), "utf8");
    expect(example).toMatch(/^FEATURE_EXTRACT=off$/m);
    expect(example).toMatch(/^GMAIL_CONTENT_ACCESS=off$/m);
  });

  it("the extraction route does nothing unless the fail-safe config is enabled", () => {
    const route = readFileSync(join(root, "app/api/cron/extract/route.ts"), "utf8");
    expect(route.indexOf("if (!cfg.enabled)")).toBeGreaterThan(-1);
    expect(route.indexOf("if (!cfg.enabled)")).toBeLessThan(route.indexOf("runExtractTick("));
    expect(route.indexOf("safeEqual(auth")).toBeLessThan(route.indexOf("runExtractTick("));
    const logs = route.match(/console\.(log|info|warn|error)\([^;]*;/g) ?? [];
    for (const l of logs) expect(l).not.toMatch(/\.message|\.stack|String\(e\)|anthropicApiKey|ANTHROPIC_API_KEY|prompt|text/);
  });

  it("extraction code never logs or throws email text", () => {
    for (const f of files(join(root, "lib/extract"))) {
      const src = readFileSync(f, "utf8");
      const logs = src.match(/(?:console\.\w+|log)\(\{[^}]*\}/g) ?? [];
      for (const l of logs) expect(l, relative(root, f)).not.toMatch(/\b(?:text|prompt|body|quote|summary|raw|html)\b/);
      expect(src, relative(root, f)).not.toMatch(/console\.(log|info|warn|error)\(/);
      expect(src, relative(root, f)).not.toMatch(/new Error\(`/);
    }
  });

  it("the extraction migration is pending: supabase db push cannot apply it", () => {
    expect(readdirSync(join(root, "supabase/migrations")).some((f) => f.includes("fact_extraction"))).toBe(false);
    expect(readdirSync(join(root, "supabase/tests")).some((f) => f.includes("fact_extraction"))).toBe(false);
  });

  it("the extraction migration enables nothing by default", () => {
    const sql = readFileSync(join(root, "supabase/pending/20261016000008_fact_extraction.sql"), "utf8");
    expect(sql).toContain("('extract_allowed_mailboxes', '')");
    expect(sql).toContain("('facts_visibility', 'reviewers')");
    expect(sql).toContain("('facts_show_source_owner', 'off')");
    expect(sql).toContain("('extract_monthly_cap_usd', '50')");
    expect(sql).not.toMatch(/create table[^;]*\b(body|subject|snippet|raw_text|html)\b\s+text/i);
  });

  it("the facts pages read only through access-checked database functions", () => {
    for (const f of ["app/(app)/facts/page.tsx", "app/(app)/facts/actions.ts"]) {
      const src = readFileSync(join(root, f), "utf8");
      expect(src, f).not.toMatch(/\.from\(|service_role|SUPABASE_SERVICE_ROLE_KEY|createExtractDb|createWorkerDb/);
    }
  });
});
