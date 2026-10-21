import { describe, expect, it } from "vitest";
import { redact, redactField } from "@/lib/extract/redact";
import { cleanBody, htmlToText, mimeText, prefilter, MAX_TEXT_CHARS } from "@/lib/extract/text";

describe("redaction: each kind is masked, and only the kind is counted", () => {
  it.each([
    ["card (Luhn-valid)", "pay with 4111 1111 1111 1111 today", "pay with [CARD] today", "card"],
    ["card without spaces", "card 5500005555555559 ok", "card [CARD] ok", "card"],
    ["IBAN", "IBAN DE89 3704 0044 0532 0130 00 please", "IBAN [IBAN] please", "iban"],
    ["IFSC", "IFSC HDFC0001234 branch", "IFSC [IFSC] branch", "ifsc"],
    ["bank account", "A/C No: 001234567890, thanks", "A/C No: [BANK], thanks", "bank"],
    ["routing number", "routing 021000021 and", "routing [BANK] and", "bank"],
    ["US SSN", "SSN 123-45-6789.", "SSN [GOV_ID].", "gov_id"],
    ["Indian PAN", "PAN ABCDE1234F.", "PAN [GOV_ID].", "gov_id"],
    ["Aadhaar", "Aadhaar 2345 6789 0123.", "Aadhaar [GOV_ID].", "gov_id"],
    ["passport", "passport no: K1234567 attached", "passport no: [GOV_ID] attached", "gov_id"],
    ["password", "the password is Hunter2xQ! for the portal", "the password is [SECRET] for the portal", "secret"],
    ["OTP", "OTP: 482913", "OTP: [SECRET]", "secret"],
    ["email", "write to jane.buyer@acmefresh.example now", "write to [EMAIL] now", "email"],
    ["link with token", "see https://x.example/a?token=abc123 here", "see [LINK] here", "link"],
    ["international phone", "call +1 (312) 555-0199 now", "call [PHONE] now", "phone"],
    ["US phone", "call (312) 555-0199 now", "call [PHONE] now", "phone"],
    ["Indian mobile", "call 98201 23456 now", "call [PHONE] now", "phone"],
  ])("%s", (_l, input, out, kind) => {
    const r = redact(input);
    expect(r.text).toBe(out);
    expect(Object.keys(r.counts)).toEqual([kind]);
    expect(JSON.stringify(r.counts)).not.toMatch(/\d{4,}/);
  });

  it("a non-Luhn 16-digit number is not called a card", () => {
    expect(redact("reference 1234 5678 9012 3456 for the shipment").counts.card).toBeUndefined();
  });

  it("business numbers survive exactly", () => {
    expect(redact("We need 5,000 cases by Nov 12 at $0.21 per tray").text).toBe("We need 5,000 cases by Nov 12 at $0.21 per tray");
    expect(redact("PO 4512 and lot 42 shipped on 2026-11-10").text).toBe("PO 4512 and lot 42 shipped on 2026-11-10");
    expect(redact("this will account for 20,000 trays next quarter").text).toBe("this will account for 20,000 trays next quarter");
  });

  it("known false positive (documented): a 12-digit reference in Aadhaar layout is masked", () => {
    expect(redact("ref 1234 5678 9012").text).toBe("ref [GOV_ID]");
  });

  it("redactField masks, collapses whitespace and caps length", () => {
    expect(redactField("call  +1 (312) 555-0199\n now", 300)).toBe("call [PHONE] now");
    expect(redactField("x".repeat(500), 200)).toHaveLength(200);
    expect(redactField(null, 10)).toBeNull();
    expect(redactField("   ", 10)).toBeNull();
  });
});

describe("cleanup and pre-filter", () => {
  it("cuts quoted history, '>' lines, signatures and disclaimers", () => {
    const t = cleanBody("Confirmed for the 20th.\n\n-- \nJane Buyer\nAcme\n\nOn Mon, Sep 14 Ravi wrote:\n> old");
    expect(t.text).toBe("Confirmed for the 20th.");
    expect(cleanBody("Hello\n> quoted line\nThere").text).toBe("Hello\nThere");
    expect(cleanBody("Order 5 pallets.\nCONFIDENTIALITY NOTICE: this email is private").text).toBe("Order 5 pallets.");
    expect(cleanBody("Ship it.\n________________________________\nFrom: Ravi\nSent: Monday").text).toBe("Ship it.");
  });

  it("caps length and flags truncation", () => {
    const t = cleanBody("a".repeat(MAX_TEXT_CHARS + 50));
    expect(t.text).toHaveLength(MAX_TEXT_CHARS);
    expect(t.truncated).toBe(true);
  });

  it("converts HTML, drops scripts, styles and blockquotes", () => {
    expect(htmlToText("<style>x{}</style><p>Need&nbsp;<b>3,000</b> cases</p><blockquote>old</blockquote><script>evil()</script>").trim()).toBe("Need 3,000 cases");
  });

  it("never reads attachments, even text ones", () => {
    const b = (s: string) => Buffer.from(s).toString("base64url");
    const m = mimeText({ mimeType: "multipart/mixed", parts: [{ mimeType: "text/plain", body: { data: b("Body text") } }, { mimeType: "text/plain", filename: "secrets.txt", body: { attachmentId: "a1" } }] });
    expect(m.text).toBe("Body text");
    expect(m.attachments).toBe(1);
  });

  it("never skips short approvals, confirmations or cancellations", () => {
    for (const t of ["Approved.", "Go ahead", "Confirmed, thanks", "Please cancel", "OK to ship", "Price works, PO to follow"]) {
      expect(prefilter({}, t, { calendar: false }), t).toBeNull();
    }
    expect(prefilter({}, "Thanks!", { calendar: false })).toBe("too_short");
    expect(prefilter({}, "Thank you so much for the update, much appreciated. Best regards", { calendar: false })).toBe("acknowledgement");
  });

  it("keeps the start of the earlier message as context, without quote markers", () => {
    const c = cleanBody("Approved.\n\nOn Tue, Oct 6 Ravi <r@x.com> wrote:\n> Please approve PO 9921\n> for 4,000 cases.");
    expect(c.text).toBe("Approved.");
    expect(c.replyContext).toBe("Please approve PO 9921\nfor 4,000 cases.");
    expect(cleanBody("No reply here.").replyContext).toBe("");
  });

  it("keeps real short business emails", () => {
    expect(prefilter({}, "Please ship 200 cases on Friday, PO 77.", { calendar: false })).toBeNull();
    expect(prefilter({}, "Thanks! Please ship 200 more cases next week as well.", { calendar: false })).toBeNull();
  });
});
