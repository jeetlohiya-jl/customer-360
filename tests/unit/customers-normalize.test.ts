import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isFreemailDomain, normalizeDomain, normalizeEmail, normalizeName } from "@/lib/customers/normalize";
import { editDistance } from "@/lib/customers/similarity";

const cases = JSON.parse(readFileSync(join(__dirname, "../fixtures/normalize-cases.json"), "utf8")) as [string, string][];

describe("normalizeName", () => {
  it.each(cases)("%s -> %s", (input, expected) => {
    expect(normalizeName(input)).toBe(expected);
  });

  it("the database test checks exactly the same cases (TypeScript and SQL stay in step)", () => {
    const sql = readFileSync(join(__dirname, "../../supabase/tests/005_customer_master.test.sql"), "utf8");
    for (const [input, expected] of cases) {
      const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;
      expect(sql).toContain(`private.normalize_name(${literal(input)}), ${literal(expected)}`);
    }
  });
});

describe("domains and emails", () => {
  it("normalizes domains and rejects junk", () => {
    expect(normalizeDomain("https://www.AcmePack.com/about")).toBe("acmepack.com");
    expect(normalizeDomain("@acmepack.com")).toBe("acmepack.com");
    expect(normalizeDomain("acmepack")).toBeNull();
    expect(normalizeDomain("acme pack.com")).toBeNull();
  });
  it("normalizes emails", () => {
    expect(normalizeEmail(" Orders@AcmePack.com ")).toBe("orders@acmepack.com");
    expect(normalizeEmail("not-an-email")).toBeNull();
  });
  it("knows free-mail providers", () => {
    expect(isFreemailDomain("gmail.com")).toBe(true);
    expect(isFreemailDomain("acmepack.com")).toBe(false);
  });
});

describe("editDistance", () => {
  it("counts missing, extra, wrong and swapped characters as one edit", () => {
    expect(editDistance("packaging", "packagng")).toBe(1);
    expect(editDistance("packaging", "packagin")).toBe(1);
    expect(editDistance("acme", "acem")).toBe(1);
    expect(editDistance("acme", "acne")).toBe(1);
    expect(editDistance("acme", "bravo")).toBe(5);
  });
  it("stops early beyond the limit", () => {
    expect(editDistance("abcdefgh", "zzzzzzzz", 2)).toBe(3);
  });
});
