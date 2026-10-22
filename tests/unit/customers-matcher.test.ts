import { describe, expect, it } from "vitest";
import { buildIndex, checkLine, decide, findNames, matchAddress, type CustomerRecord } from "@/lib/customers/matcher";

// Synthetic customers only.
const ACME = "00000000-0000-4000-8000-00000000a001";
const ACMEPACKCO = "00000000-0000-4000-8000-00000000a002";
const BRAVO = "00000000-0000-4000-8000-00000000b001";
const DISTRIB = "00000000-0000-4000-8000-00000000c001";
const GONE = "00000000-0000-4000-8000-00000000d001";

const customers: CustomerRecord[] = [
  {
    id: ACME,
    canonicalName: "Acme Packaging Limited",
    status: "active",
    names: [{ value: "Acme Pack", kind: "trading" }],
    domains: [{ value: "acmepackaging.com", shared: false }],
    emails: ["buyer@outlook.com"],
  },
  { id: ACMEPACKCO, canonicalName: "Acme Pack Co of Texas", status: "active", names: [], domains: [], emails: [] },
  { id: BRAVO, canonicalName: "Bravo Foods Inc", status: "active", names: [{ value: "Fresh Foods", kind: "alias" }], domains: [{ value: "bravofoods.com", shared: false }], emails: [] },
  { id: DISTRIB, canonicalName: "Delta Distribution", status: "active", names: [], domains: [{ value: "deltadist.com", shared: true }], emails: [] },
  { id: GONE, canonicalName: "Zephyr Meats", status: "inactive", names: [], domains: [{ value: "zephyr.com", shared: false }], emails: [] },
];

const index = buildIndex({ customers, distinctions: [], rejections: ["acme packaginng"], workspaceDomain: "gocirkla.com" });
const outcome = (line: string) => checkLine(index, line).decision;

describe("exact names, case, punctuation, suffixes, aliases", () => {
  it.each([
    "Acme Packaging Limited",
    "ACME PACKAGING LIMITED",
    "Acme Packaging Ltd.",
    "Acme Packaging",
    "RE: Acme Packaging, L.L.C. sample request",
    "Acme Pack",
  ])("%s links to Acme", (line) => {
    const d = outcome(line);
    expect(d.outcome).toBe("link");
    expect(d.customerIds).toEqual([ACME]);
  });

  it("prefers the longest exact name: 'Acme Pack Co of Texas' is the Texas company, not Acme Pack", () => {
    const d = outcome("Order for Acme Pack Co of Texas");
    expect(d.customerIds).toEqual([ACMEPACKCO]);
    expect(d.outcome).toBe("link");
  });
});

describe("m2: obvious variants of one customer's name link directly", () => {
  it.each([
    ["AcmePackaging", "words run together"],
    ["RE: acmepackaging order", "words run together in a subject"],
    ["Bravo Food", "plural dropped"],
    ["Bravo Foods's samples", "possessive"],
  ])("%s links (%s)", (line) => {
    const d = outcome(line);
    expect(d.outcome).toBe("link");
  });

  it("run-together letters shared by two customers still go to review", () => {
    const twin = buildIndex({
      customers: [
        { id: ACME, canonicalName: "Taylor Farms", status: "active", names: [], domains: [], emails: [] },
        { id: BRAVO, canonicalName: "Taylorf Arms", status: "active", names: [], domains: [], emails: [] },
      ],
      distinctions: [], rejections: [],
    });
    expect(checkLine(twin, "taylorfarms").decision.outcome).toBe("review");
  });

  it("a domain that IS the customer's name links; one letter off is still only a look-alike", () => {
    const plain = buildIndex({
      customers: [{ id: ACME, canonicalName: "Premio Foods", status: "active", names: [], domains: [], emails: [] }],
      distinctions: [], rejections: [], workspaceDomain: "gocirkla.com",
    });
    expect(matchAddress(plain, "greg@premiofoods.com")?.evidence).toBe("E2");
    expect(checkLine(plain, "greg@premiofoods.com").decision.outcome).toBe("link");
    expect(matchAddress(plain, "greg@premofoods.com")?.evidence).toBe("E5");
  });

  it("a generic name never links from spacing or plural alone", () => {
    const generic = buildIndex({
      customers: [{ id: ACME, canonicalName: "Fresh Foods", status: "active", names: [], domains: [], emails: [] }],
      distinctions: [], rejections: [],
    });
    expect(checkLine(generic, "freshfoods").decision.outcome).not.toBe("link");
    expect(checkLine(generic, "Fresh Food").decision.outcome).not.toBe("link");
  });
});

describe("spelling mistakes go to review, never link", () => {
  it.each(["Acme Packagng", "Acme Packagin", "Acem Packaging"])("%s -> review for Acme", (line) => {
    const d = outcome(line);
    expect(d.outcome).toBe("review");
    expect(d.customerIds).toEqual([ACME]);
  });

  it("does not propose a match when two words are both misspelled", () => {
    expect(outcome("Acne Pakaging").outcome).toBe("none");
  });

  it("does not fuzzy-match short single words", () => {
    expect(outcome("acne").outcome).toBe("none");
  });

  it("a rejected spelling is not proposed again", () => {
    expect(findNames(index, "Acme Packaginng")).toEqual([]);
  });
});

describe("similar names, different companies", () => {
  it("two customers in one line always go to review", () => {
    const d = outcome("Acme Packaging and Bravo Foods joint trial");
    expect(d.outcome).toBe("review");
    expect(d.customerIds.sort()).toEqual([ACME, BRAVO].sort());
  });

  it("customers marked as different do not cross-propose", () => {
    const withDistinct = buildIndex({ customers, distinctions: [[ACME, ACMEPACKCO]], rejections: [] });
    const hits = findNames(withDistinct, "Acme Packaging");
    expect(hits.map((h) => h.customerId)).toEqual([ACME]);
  });

  it("a generic alias alone is not enough to link", () => {
    expect(outcome("Fresh Foods").outcome).toBe("review");
  });

  it("inactive customers are not matched", () => {
    expect(outcome("Zephyr Meats").outcome).toBe("none");
  });
});

describe("domains and addresses", () => {
  it("verified exclusive domain links (E2)", () => {
    expect(matchAddress(index, "jane@acmepackaging.com")?.evidence).toBe("E2");
    expect(outcome("jane@acmepackaging.com").outcome).toBe("link");
  });
  it("an approved address links even on a free-mail provider (E1)", () => {
    expect(matchAddress(index, "Buyer@Outlook.com")?.evidence).toBe("E1");
  });
  it("other free-mail addresses give no evidence", () => {
    expect(matchAddress(index, "someone@gmail.com")).toBeNull();
  });
  it("a shared domain only sends to review", () => {
    expect(outcome("rep@deltadist.com").outcome).toBe("review");
  });
  it("an unverified look-alike domain only sends to review (E5)", () => {
    expect(matchAddress(index, "x@bravofods.net")?.evidence).toBe("E5");
    expect(outcome("x@bravofods.net").outcome).toBe("review");
  });
  it("Cirkla's own domain is never customer evidence", () => {
    expect(matchAddress(index, "kartik@gocirkla.com")).toBeNull();
  });
});

describe("decide()", () => {
  it("no evidence means no match", () => {
    expect(decide([], []).outcome).toBe("none");
  });
  it("records the rules version for later re-runs", () => {
    expect(decide([], []).rulesVersion).toBe("m2");
  });
});
