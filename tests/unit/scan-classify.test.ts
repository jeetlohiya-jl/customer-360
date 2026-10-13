import { describe, expect, it } from "vitest";
import { buildIndex, type CustomerRecord } from "@/lib/customers/matcher";
import { classifyMessage, parseAddresses } from "@/lib/scan/classify";
import type { MessageHeaders } from "@/lib/gmail/google";

// Synthetic customers and messages only.
const ACME = "00000000-0000-4000-8000-00000000a001";
const BRAVO = "00000000-0000-4000-8000-00000000b001";
const DELTA = "00000000-0000-4000-8000-00000000d001";
const customers: CustomerRecord[] = [
  { id: ACME, canonicalName: "Acme Packaging Limited", status: "active", names: [], domains: [{ value: "acmepackaging.com", shared: false }], emails: [] },
  { id: BRAVO, canonicalName: "Bravo Foods Inc", status: "active", names: [], domains: [], emails: ["buyer@outlook.com"] },
  { id: DELTA, canonicalName: "Delta Distribution", status: "active", names: [], domains: [{ value: "deltadist.com", shared: true }], emails: [] },
];
const index = buildIndex({ customers, distinctions: [], rejections: [], workspaceDomain: "gocirkla.com" });
const OWNER = "pilot.owner@gocirkla.com";
const ctx = { ownerEmail: OWNER, workspaceDomain: "gocirkla.com", cutoffMs: Date.parse("2026-10-14T00:00:00Z"), excludeLabelIds: new Set(["Label_9"]) };

let n = 0;
function msg(h: Partial<Record<string, string>>, labelIds: string[] = ["INBOX"], date = "2026-09-01T10:00:00Z"): MessageHeaders {
  n++;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined) headers[k.toLowerCase()] = v;
  return { id: `m${n.toString(16).padStart(6, "0")}`, threadId: `t${n}`, labelIds, internalDate: Date.parse(date), headers };
}

describe("parseAddresses", () => {
  it("handles quoted names with commas and several recipients", () => {
    expect(parseAddresses('"Doe, Jane" <Jane@AcmePackaging.com>, bob@x.com, Team (Acme) <t@y.com>')).toEqual([
      { name: "Doe, Jane", email: "jane@acmepackaging.com" },
      { name: "", email: "bob@x.com" },
      { name: "Team (Acme)", email: "t@y.com" },
    ]);
  });
});

describe("classifyMessage", () => {
  it("links on a verified customer domain and stores the customer contact (CS4), not the subject (CS3)", () => {
    const out = classifyMessage(msg({ From: "Jane <jane@acmepackaging.com>", To: OWNER, Subject: "Tray samples and pricing" }), index, ctx);
    expect(out.bucket).toBe("matched");
    expect(out.links).toHaveLength(1);
    const link = out.links[0];
    expect(link).toMatchObject({ customer_id: ACME, direction: "inbound", customer_addresses: ["jane@acmepackaging.com"], score: 1 });
    expect(link.evidence).toEqual([{ type: "E2", value: "acmepackaging.com" }]);
    expect(JSON.stringify(out)).not.toContain("Tray samples");
  });

  it("links on an exact customer name in the subject; stores the approved name only", () => {
    const out = classifyMessage(msg({ From: OWNER, To: "someone@gmail.com", Subject: "RE: Acme Packaging Ltd order" }), index, ctx);
    expect(out.bucket).toBe("matched");
    expect(out.links[0]).toMatchObject({ customer_id: ACME, direction: "outbound", customer_addresses: [] });
    expect(out.links[0].evidence).toEqual([{ type: "E3", value: "acme packaging" }]);
  });

  it("never stores colleagues' or unknown free-mail addresses", () => {
    const out = classifyMessage(msg({ From: "x@gmail.com", To: OWNER, Cc: "colleague@gocirkla.com", Subject: "Acme Packaging" }), index, ctx);
    expect(out.links[0].customer_addresses).toEqual([]);
  });

  it("an approved address on a free-mail provider links (E1)", () => {
    const out = classifyMessage(msg({ From: "buyer@outlook.com", To: OWNER, Subject: "hello" }), index, ctx);
    expect(out.links[0]).toMatchObject({ customer_id: BRAVO, customer_addresses: ["buyer@outlook.com"] });
  });

  it("a misspelt name goes to review with only the name fragment", () => {
    const out = classifyMessage(msg({ From: "x@unknown.com", To: OWNER, Subject: "Acme Packagng invoice 4411" }), index, ctx);
    expect(out.bucket).toBe("in_review");
    expect(out.reviews).toEqual([{ observed: "acme packagng", reason: "possible spelling variation", candidates: [{ customer_id: ACME, score: expect.any(Number), evidence: "E4" }] }]);
    expect(JSON.stringify(out)).not.toContain("invoice");
  });

  it("a shared domain alone is not linked (counted as weak evidence)", () => {
    const out = classifyMessage(msg({ From: "rep@deltadist.com", To: OWNER, Subject: "catalogue" }), index, ctx);
    expect(out).toMatchObject({ bucket: "unmatched", weakEvidenceOnly: true, links: [] });
  });

  it("a message with two customers on strong evidence links to both", () => {
    const out = classifyMessage(msg({ From: "jane@acmepackaging.com", To: OWNER, Cc: "buyer@outlook.com", Subject: "joint trial" }), index, ctx);
    expect(out.links.map((l) => l.customer_id).sort()).toEqual([ACME, BRAVO].sort());
  });

  it("no customer evidence: unmatched, nothing kept", () => {
    const out = classifyMessage(msg({ From: "news@vendor.com", To: OWNER, Subject: "Weekly digest", "List-Unsubscribe": "<x>" }), index, ctx);
    expect(out).toEqual({ bucket: "unmatched", links: [], reviews: [], weakEvidenceOnly: false });
  });

  describe("exclusions run before matching", () => {
    it.each([
      [{ Subject: "Acme Packaging", From: "jane@acmepackaging.com" }, ["SPAM"], "excluded_rule"],
      [{ Subject: "Acme Packaging", From: "jane@acmepackaging.com" }, ["DRAFT"], "excluded_rule"],
      [{ Subject: "Acme Packaging", From: "jane@acmepackaging.com" }, ["INBOX", "Label_9"], "excluded_rule"],
      [{ Subject: "Acme Packaging", From: "jane@acmepackaging.com", Sensitivity: "Private" }, ["INBOX"], "excluded_privacy"],
      [{ Subject: "Your verification code for Acme Packaging portal", From: "jane@acmepackaging.com" }, ["INBOX"], "excluded_privacy"],
      [{ Subject: "Acme Packaging - salary revision", From: "jane@acmepackaging.com" }, ["INBOX"], "excluded_privacy"],
      [{ Subject: "Confidential: Acme Packaging", From: "jane@acmepackaging.com" }, ["INBOX"], "excluded_privacy"],
      [{ Subject: "Security alert", From: "no-reply@accounts.google.com" }, ["INBOX"], "excluded_privacy"],
      [{ Subject: "Acme Packaging plan", From: "boss@gocirkla.com", To: OWNER }, ["INBOX"], "excluded_internal"],
    ])("%j %j -> %s", (h, labels, bucket) => {
      const out = classifyMessage(msg({ To: OWNER, ...h }, labels), index, ctx);
      expect(out.bucket).toBe(bucket);
      expect(out.links).toEqual([]);
      expect(out.reviews).toEqual([]);
    });
  });

  it("messages newer than the scan start are left for later", () => {
    const out = classifyMessage(msg({ From: "jane@acmepackaging.com", To: OWNER }, ["INBOX"], "2026-10-15T00:00:00Z"), index, ctx);
    expect(out.bucket).toBe("newer_than_cutoff");
  });
});
