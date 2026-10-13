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

describe("Stage 3.0 guards: no Gmail scanning, no new permissions", () => {
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

  it("no background job or cron is configured yet", () => {
    const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"));
    expect(vercel.crons).toBeUndefined();
  });
});
