import { describe, expect, it } from "vitest";
import { parseCsv, splitList } from "@/lib/customers/csv";
import { planCommit, previewImport, type ExistingData } from "@/lib/customers/import";

const EXISTING_ACME = "00000000-0000-4000-8000-00000000a001";
const existing: ExistingData = {
  workspaceDomain: "gocirkla.com",
  distinctions: [],
  customers: [
    {
      id: EXISTING_ACME,
      canonicalName: "Acme Packaging Limited",
      status: "active",
      names: [{ value: "Acme Pack", kind: "trading" }],
      domains: [{ value: "acmepackaging.com", shared: false }],
      emails: [],
    },
  ],
};

const header = "canonical_name,legal_names,trading_names,aliases,domains,shared_domains,emails,notes,status";

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, CRLF and a byte-order mark", () => {
    const rows = parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n');
    expect(rows).toEqual([["a", "b"], ["x, y", 'say "hi"']]);
  });
  it("rejects an unclosed quote", () => {
    expect(() => parseCsv('a\n"oops')).toThrow(/never closed/);
  });
  it("splits multi-value cells", () => {
    expect(splitList(" a; b;; a ")).toEqual(["a", "b"]);
  });
});

describe("previewImport", () => {
  it("classifies new, update, duplicate, rejected rows with reasons", () => {
    const csv = [
      header,
      "Bravo Foods Inc,,,Bravo,bravofoods.com,,orders@bravofoods.com,Ohio processor,active", // 2 new
      "ACME PACKAGING LTD,,,,,,,,", // 3 update existing Acme
      "Acme Packagng Inc,,,,acmepkg.com,,,,", // 4 possible duplicate of Acme
      ",,,,,,,,", // 5 missing name
      "Charlie Meats,,,,gmail.com,,,,", // 6 free-mail domain
      "Delta Farms,,,,gocirkla.com,,,,", // 7 Cirkla domain
      "Echo Trays,,,,acmepackaging.com,,,,", // 8 domain owned by Acme
      "Bravo Foods,,,,,,,,", // 9 same as line 2
      "Foxtrot Fiber,,,,,,not-an-email,,maybe", // 10 bad email + bad status
      "Golf Containers,,,,,,,,", // 11 new, no domain (warning)
    ].join("\n");
    const p = previewImport(csv, existing);
    const byLine = Object.fromEntries(p.rows.map((r) => [r.line, r]));

    expect(byLine[2].status).toBe("new");
    expect(byLine[3].status).toBe("update");
    expect(byLine[3].existingId).toBe(EXISTING_ACME);
    expect(byLine[4].status).toBe("possible_duplicate");
    expect(byLine[4].candidates[0].customerId).toBe(EXISTING_ACME);
    expect(byLine[5].errors).toContain("Missing canonical_name.");
    expect(byLine[6].errors.join()).toMatch(/free email provider/);
    expect(byLine[7].errors.join()).toMatch(/Cirkla's own domain/);
    expect(byLine[8].errors.join()).toMatch(/already belongs to "Acme Packaging Limited"/);
    expect(byLine[9].errors.join()).toMatch(/Same customer name as line 2/);
    expect(byLine[10].errors.length).toBe(2);
    expect(byLine[11].status).toBe("new");
    expect(byLine[11].warnings.join()).toMatch(/names only/);
    expect(p.summary).toMatchObject({ total: 10, new: 2, update: 1, possible_duplicate: 1, rejected: 6 });
  });

  it("flags similar names inside the same file", () => {
    const p = previewImport([header, "Hotel Packaging Group,,,,,,,,", "Hotel Packagng Group,,,,,,,,"].join("\n"), existing);
    expect(p.rows[1].status).toBe("possible_duplicate");
    expect(p.rows[1].candidates[0].line).toBe(2);
  });

  it("requires the canonical_name column and reports ignored columns", () => {
    expect(previewImport("name,domains\nAcme,acme.com", existing).fileErrors[0]).toMatch(/canonical_name/);
    expect(previewImport("canonical_name,colour\nAcme X,blue", existing).ignoredColumns).toEqual(["colour"]);
  });
});

describe("planCommit", () => {
  const csv = [header, "Bravo Foods Inc,,,,bravofoods.com,,,,", "Acme Packagng Inc,,,,,,,,", "Hotel Group,,,,,,,,"].join("\n");
  const p = previewImport(csv, existing);

  it("refuses to plan while a possible duplicate has no decision", () => {
    expect(planCommit(p, {}).missingDecisions).toEqual([3]);
  });

  it("'create' marks the pair as different customers", () => {
    const plan = planCommit(p, { 3: "create" });
    const row = plan.rows.find((r) => r.ref === 3)!;
    expect(row.action).toBe("create");
    expect(row.distinct_from_customers).toEqual([EXISTING_ACME]);
    expect(plan.counts).toMatchObject({ create: 3, update: 0 });
  });

  it("'merge' adds the name as an alias of the existing customer", () => {
    const plan = planCommit(p, { 3: `merge:${EXISTING_ACME}` });
    const row = plan.rows.find((r) => r.ref === 3)!;
    expect(row).toMatchObject({ action: "update", customer_id: EXISTING_ACME });
    expect(row.names[0]).toEqual({ value: "Acme Packagng Inc", kind: "alias" });
  });

  it("rejects a merge into a customer that was not a candidate", () => {
    expect(planCommit(p, { 3: "merge:00000000-0000-4000-8000-000000000999" }).invalidDecisions).toEqual([3]);
  });

  it("'skip' leaves the row out", () => {
    expect(planCommit(p, { 3: "skip" }).counts.skipped).toBe(1);
  });
});
