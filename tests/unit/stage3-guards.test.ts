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

  it("the only background job is the scan route, and it does nothing unless FEATURE_SCAN=on", () => {
    const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"));
    expect(vercel.crons).toEqual([{ path: "/api/cron/scan", schedule: "* * * * *" }]);
    const route = readFileSync(join(root, "app/api/cron/scan/route.ts"), "utf8");
    expect(route.indexOf('FEATURE_SCAN !== "on"')).toBeGreaterThan(-1);
    expect(route.indexOf('FEATURE_SCAN !== "on"')).toBeLessThan(route.indexOf("runTick("));
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

  it("Gmail permission is still gmail.metadata only", () => {
    const google = readFileSync(join(root, "lib/gmail/google.ts"), "utf8");
    expect(google.match(/https:\/\/www\.googleapis\.com\/auth\/gmail\.[a-z]+/g)).toEqual([
      "https://www.googleapis.com/auth/gmail.metadata",
    ]);
  });
});
