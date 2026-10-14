/**
 * Stage C: the fixed instructions and output schema sent to the model.
 * Versioned: every stored fact records PROMPT_VERSION.
 */

export const PROMPT_VERSION = "x1";
export const MODEL_ID = "claude-haiku-5-5";
export const MAX_OUTPUT_TOKENS = 1500;

export const FACT_TYPES = ["requirement", "order", "pricing", "delivery", "quality_issue", "follow_up"] as const;
export const STANCES = ["request", "proposal", "commitment", "report", "cancellation"] as const;
export const STATUSES = ["open", "resolved", "cancelled", "not_applicable", "unknown"] as const;

export const SYSTEM_PROMPT = `You extract business facts from ONE business email between Cirkla (a molded-fiber packaging manufacturer) and one of its customers, for Cirkla's internal customer records.

Return facts only by calling the record_facts tool. Return an empty list when the email holds no business facts.

Fact types:
- requirement: what the customer needs (product, specification, volume, forecast)
- order: a purchase order or order quantity
- pricing: a price asked for, quoted or agreed, with its basis
- delivery: a ship or delivery date asked for, promised or reported
- quality_issue: a complaint or defect, or its resolution
- follow_up: an action someone owes (send samples, call back, share a document)

Stance (be strict; this matters most):
- request: someone asks for something ("can you", "please send", "we need", a question). A customer asking for a quantity or date is a REQUEST, not an order.
- proposal: an offer or quote that has not been accepted ("we can offer", "our price would be").
- commitment: ONLY when the party bound by it explicitly agrees or confirms in this email ("PO attached, please proceed", "we confirm shipment on", "approved"). Never infer a commitment.
- report: a statement of fact or status ("the container left today", "lot 42 is leaking").
- cancellation: something is withdrawn, put on hold or cancelled.

party: who made the statement: customer, cirkla or unclear. Direction tells you who sent the email.
basis: explicit if the email states it directly; inferred if you are reading between the lines.
status: open, resolved, cancelled, not_applicable or unknown. status_basis: explicit, inferred, or none when status is unknown or not_applicable.

Earlier open facts for this customer are listed with their ids. If this email resolves, cancels or updates one of them, put that id in resolves_fact_id and set status (resolved or cancelled) and status_basis (explicit only if the email says so outright).

Rules:
- Use only information in this email. Never guess numbers, dates, prices or currencies. Leave a field null when it is not stated.
- evidence_quote: copy at most 200 characters VERBATIM from the email that supports the fact. Do not paraphrase inside the quote.
- summary: one plain sentence, at most 300 characters.
- Text shown as [EMAIL], [PHONE], [CARD], [BANK], [GOV_ID], [SECRET], [LINK], [IBAN] or [IFSC] was removed on purpose. Never try to restore it.
- Do not extract anything about people's health, family, personal life, salaries, immigration, legal disputes or HR matters. Skip those parts entirely.
- confidence: 0 to 1, how sure you are that the fact, its stance and its numbers are right.
- If a fact seems to be about a different company than the customers listed, set about_other_customer to true.`;

export const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    facts: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        properties: {
          customer_id: { type: "string", description: "One of the customer ids given" },
          fact_type: { type: "string", enum: [...FACT_TYPES] },
          stance: { type: "string", enum: [...STANCES] },
          party: { type: "string", enum: ["customer", "cirkla", "unclear"] },
          basis: { type: "string", enum: ["explicit", "inferred"] },
          status: { type: "string", enum: [...STATUSES] },
          status_basis: { type: "string", enum: ["explicit", "inferred", "none"] },
          resolves_fact_id: { type: ["string", "null"] },
          product: { type: ["string", "null"] },
          quantity: { type: ["number", "null"] },
          unit: { type: ["string", "null"] },
          unit_price: { type: ["number", "null"] },
          currency: { type: ["string", "null"], description: "ISO 4217 code such as USD or INR" },
          price_basis: { type: ["string", "null"] },
          due_date: { type: ["string", "null"], description: "YYYY-MM-DD only if a full date is stated or unambiguous" },
          due_text: { type: ["string", "null"] },
          reference: { type: ["string", "null"], description: "PO, quote or lot number" },
          summary: { type: "string" },
          evidence_quote: { type: ["string", "null"] },
          confidence: { type: "number" },
          about_other_customer: { type: "boolean" },
        },
        required: ["customer_id", "fact_type", "stance", "party", "basis", "status", "status_basis", "summary", "confidence"],
      },
    },
  },
  required: ["facts"],
} as const;

export interface PromptInput {
  customers: { id: string; name: string }[];
  date: string; // YYYY-MM-DD
  direction: "inbound" | "outbound";
  openFacts: { id: string; customer_id: string; type: string; summary: string; date: string }[];
  /** Cleaned, REDACTED email text. */
  text: string;
}

/** The per-email message. Contains no email addresses or mailbox owner identity. */
export function buildUserMessage(p: PromptInput): string {
  const customers = p.customers.map((c) => `- ${c.name} (id ${c.id})`).join("\n");
  const open = p.openFacts.length
    ? p.openFacts.map((f) => `- id ${f.id} · ${f.type} · ${f.date} · ${f.summary}`).join("\n")
    : "- none";
  return [
    `Customer(s) this email is linked to:\n${customers}`,
    `Email date: ${p.date}. Direction: ${p.direction === "inbound" ? "sent BY the customer to Cirkla" : "sent BY Cirkla to the customer"}.`,
    `Earlier open facts for these customers:\n${open}`,
    `Email text (cleaned and redacted):\n<<<\n${p.text}\n>>>`,
  ].join("\n\n");
}
