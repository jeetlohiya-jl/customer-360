/**
 * Stage B + C pipeline on synthetic emails with scripted model answers.
 * Tests OUR logic: cleanup, pre-filter, redaction and the checks on whatever
 * the model returns. Model quality itself is measured separately by the live
 * evaluation (tests/eval), which needs your approval to run.
 */
import { describe, expect, it } from "vitest";
import { prepareMessage } from "@/lib/extract/run";
import { validateFacts } from "@/lib/extract/validate";
import { CASES, CUSTOMERS, OWNER_EMAIL, PLANTED } from "../fixtures/synthetic-emails";

const item = (direction: "inbound" | "outbound") => ({ mailbox_email: OWNER_EMAIL, message_at: "2026-09-15T10:00:00.000Z", direction, customers: CUSTOMERS });

describe.each(CASES)("synthetic email: $name", (c) => {
  it(c.about, () => {
    const prep = prepareMessage(c.msg, item(c.direction), c.openFacts ?? [], new Set(c.excludeLabel ? ["Label_9"] : []));
    if ("skip" in c.expect) {
      expect(prep).toEqual({ kind: "skip", reason: c.expect.skip });
      return;
    }
    expect(prep.kind).toBe("ready");
    if (prep.kind !== "ready") return;
    const want = c.expect;
    const v = validateFacts(c.model, {
      text: prep.text,
      customers: CUSTOMERS,
      openFacts: (c.openFacts ?? []).map((f) => ({ id: f.id, customer_id: f.customer_id })),
      truncated: prep.truncated,
    });
    expect(v.facts.map((f) => ({
      fact_type: f.fact_type,
      stance: f.stance,
      ...(want.facts.some((e) => e.status !== undefined) ? { status: f.status } : {}),
      ...(want.facts.some((e) => e.status_basis !== undefined) ? { status_basis: f.status_basis } : {}),
      ...(want.facts.some((e) => e.resolves !== undefined) ? { resolves: f.resolves_fact_id } : {}),
      ...(want.facts.some((e) => e.quantity !== undefined) ? { quantity: f.quantity } : {}),
      ...(want.facts.some((e) => e.unit_price !== undefined) ? { unit_price: f.unit_price } : {}),
      reasons: f.review_reasons,
    }))).toEqual(want.facts);
    expect(v.dropped).toEqual(want.dropped ?? {});
  });
});

describe("guarantees across every synthetic case", () => {
  const ready = CASES.map((c) => ({ c, prep: prepareMessage(c.msg, item(c.direction), c.openFacts ?? [], new Set(c.excludeLabel ? ["Label_9"] : [])) }));
  const all = ready.flatMap(({ c, prep }) =>
    prep.kind === "ready" && c.model
      ? validateFacts(c.model, { text: prep.text, customers: CUSTOMERS, openFacts: (c.openFacts ?? []).map((f) => ({ id: f.id, customer_id: f.customer_id })), truncated: prep.truncated }).facts
      : [],
  );

  it("no planted secret ever reaches the model prompt", () => {
    for (const { prep } of ready) {
      if (prep.kind !== "ready") continue;
      for (const [kind, value] of Object.entries(PLANTED)) expect(prep.prompt, kind).not.toContain(value);
    }
  });

  it("no planted secret is ever in a stored fact", () => {
    const stored = JSON.stringify(all);
    for (const [kind, value] of Object.entries(PLANTED)) expect(stored, kind).not.toContain(value);
  });

  it("the prompt never contains email addresses or the mailbox owner", () => {
    for (const { prep } of ready) {
      if (prep.kind !== "ready") continue;
      expect(prep.prompt).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      expect(prep.prompt).not.toContain(OWNER_EMAIL);
    }
  });

  it("no stored commitment is inferred or rests on a question", () => {
    for (const f of all.filter((x) => x.stance === "commitment")) {
      expect(f.basis).toBe("explicit");
      expect(f.evidence_quote).toBeTruthy();
      expect(f.evidence_quote).not.toMatch(/\?/);
    }
  });

  it("every stored quote is word for word in the redacted text, and at most 200 characters", () => {
    for (const { c, prep } of ready) {
      if (prep.kind !== "ready" || !c.model) continue;
      const v = validateFacts(c.model, { text: prep.text, customers: CUSTOMERS, openFacts: (c.openFacts ?? []).map((f) => ({ id: f.id, customer_id: f.customer_id })), truncated: prep.truncated });
      for (const f of v.facts) {
        if (!f.evidence_quote) continue;
        expect(f.evidence_quote.length).toBeLessThanOrEqual(200);
        expect(prep.text.replace(/\s+/g, " ").toLowerCase()).toContain(f.evidence_quote.toLowerCase());
      }
    }
  });

  it("quoted reply history and attachments never reach the model", () => {
    for (const { prep } of ready) {
      if (prep.kind !== "ready") continue;
      expect(prep.prompt).not.toContain(PLANTED.quotedSecret);
      expect(prep.prompt).not.toContain("PO-4512.pdf");
    }
  });

  it("the suite covers requests, proposals, commitments, cancellations and both kinds of resolution", () => {
    const stances = new Set(all.map((f) => f.stance));
    for (const s of ["request", "proposal", "commitment", "report", "cancellation"]) expect(stances).toContain(s);
    expect(all.some((f) => f.status === "resolved" && f.status_basis === "explicit")).toBe(true);
    expect(all.some((f) => f.status === "resolved" && f.status_basis === "inferred" && f.review_reasons.includes("inferred_status"))).toBe(true);
    expect(CASES.length).toBeGreaterThanOrEqual(30);
  });
});
