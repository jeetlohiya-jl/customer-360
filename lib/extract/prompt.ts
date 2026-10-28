/**
 * Stage C: the fixed instructions and output schema sent to the model.
 * Versioned: every stored fact records PROMPT_VERSION.
 */

export const PROMPT_VERSION = "x6";
export const MODEL_ID = "claude-haiku-5-5";
export const MAX_OUTPUT_TOKENS = 1500;

export const FACT_TYPES = ["requirement", "order", "pricing", "delivery", "quality_issue", "follow_up"] as const;
export const STANCES = ["request", "proposal", "commitment", "report", "cancellation"] as const;
export const STATUSES = ["open", "resolved", "cancelled", "not_applicable", "unknown"] as const;

export const SYSTEM_PROMPT = `You extract business facts from ONE business email between Cirkla (a molded-fiber packaging manufacturer) and one of its customers, for Cirkla's internal customer records.

Return facts only by calling the record_facts tool. Return an empty list when the email holds no business facts.
Record only facts a salesperson would want in the customer's record. Never record: meeting scheduling or availability ("tomorrow works", "free after 1:30"), out-of-office or PTO notes, greetings, or carrier/courier service questions. Quality over quantity: one precise fact beats three vague ones, and most routine emails have none.

Fact types:
- requirement: what the customer needs (product, specification, volume, forecast)
- order: a purchase order or order quantity
- pricing: a price asked for, quoted or agreed, with its basis
- delivery: a ship or delivery date asked for, promised or reported
- quality_issue: a complaint or defect, or its resolution
- follow_up: a CONCRETE business action someone owes, with a clear owner: send samples, a quote, a PI or invoice, artwork, a credit note, specifications or documents; arrange a trial; resolve a claim. NOT courtesies or routine replies ("let me know", "I'll get back to you", "thanks, noted", "please confirm receipt", "let's catch up", scheduling a call).

Stance (be strict; this matters most):
- request: someone asks for something ("can you", "please send", "we need", a question). A customer asking for a quantity or date is a REQUEST, not an order.
- proposal: an offer or quote that has not been accepted ("we can offer", "our price would be").
- commitment: ONLY when the party bound by it explicitly agrees or confirms in this email ("PO attached, please proceed", "we confirm shipment on", "approved"). Never infer a commitment.
- report: a statement of fact or status ("the container left today", "lot 42 is leaking").
- cancellation: something is withdrawn, put on hold or cancelled.

party: who made the statement: customer, cirkla or unclear. Direction tells you who sent the email.
Internal emails (Direction: internal) are between Cirkla colleagues about the customer and were not sent to the customer. Record Cirkla's own decisions, plans, prices worked out, sample and shipping arrangements and actions owed by named colleagues (party: cirkla). A customer's statement quoted inside an internal email is still party customer. Never record colleagues' opinions of people, internal disagreements or anything personal.
basis: explicit if the email states it directly; inferred if you are reading between the lines.
status: open, resolved, cancelled, not_applicable or unknown. status_basis: explicit, inferred, or none when status is unknown or not_applicable.

Earlier open facts for this customer are listed with their ids. If this email resolves, cancels or updates one of them, put that id in resolves_fact_id and set status (resolved or cancelled) and status_basis (explicit only if the email says so outright).

Rules:
- Use only information in this email. Never guess numbers, dates, prices or currencies. Leave a field null when it is not stated.
- evidence_quote: copy at most 200 characters VERBATIM from the email that supports the fact. Do not paraphrase inside the quote.
- summary: one plain sentence, at most 300 characters. Name the person who said, asked or agreed it, with their company: "Greg (Premio Foods) asked for…", "Glenn (Cirkla) confirmed…".
- Who is who: the "From" line names the person who WROTE this email; everything the email text says is theirs, except a statement it clearly quotes from someone else. "To" and "Cc" name the recipients: name them only as the people asked, told or sent something ("Vaibhav (Cirkla) asked Glenn (Cirkla) to…"). A greeting ("Hi Glenn") names a recipient, never the writer. Use the names exactly as the From/To/Cc lines give them (first name is fine). Never invent a name; if it is not clear who, use the company name.
- Text shown as [EMAIL], [PHONE], [CARD], [BANK], [GOV_ID], [SECRET], [LINK], [IBAN] or [IFSC] was removed on purpose. Never try to restore it.
- Do not extract anything about people's health, family, personal life, salaries, immigration, legal disputes or HR matters. Skip those parts entirely.
- confidence: 0 to 1, how sure you are that the fact, its stance and its numbers are right. Use the full range: 0.9 or more when the email states it plainly, around 0.6 when you are interpreting, below 0.5 when unsure.
- If a fact is about, or comes from, a company other than the customers listed (for example a carrier, logistics firm, film or packaging supplier, or another customer), set about_other_customer to true.
- A confirmed FUTURE delivery or shipment is a commitment with status open; it becomes resolved only when an email says it was delivered.
- "Earlier message" text, when present, is the email this short reply answers. Use it ONLY to understand the reply (e.g. what "Approved" refers to). Extract facts from the reply itself; evidence_quote must come from the reply, not from the earlier message.`;

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
  direction: "inbound" | "outbound" | "internal";
  openFacts: { id: string; customer_id: string; type: string; summary: string; date: string }[];
  /** Cleaned, REDACTED email text. */
  text: string;
  /** REDACTED subject line (sent for context, never stored). */
  subject?: string;
  /** REDACTED start of the earlier message, only for short replies. */
  replyContext?: string;
  /** Names (no addresses) of the writer and recipients, from the From/To/Cc headers. */
  people?: EmailPeople;
}

export interface EmailPeople {
  from: string[];
  to: string[];
  cc: string[];
}

const MAX_PEOPLE = 8;

/**
 * "Vaibhav Agarwal <vaibhav@gocirkla.com>, greg@premiofoods.com" ->
 * ["Vaibhav Agarwal (Cirkla)", "Greg (premiofoods.com)"]. Addresses are never
 * returned: a display name is used, or a name read from the address's local part,
 * plus the company (Cirkla) or the other side's domain.
 */
export function headerPeople(value: string | undefined, workspaceDomain: string): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const part of value.slice(0, 4000).match(/(?:"[^"]*"|[^,"])+/g) ?? []) {
    const m = part.match(/^\s*(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/) ?? part.match(/^\s*()([^<>\s,]+@[^<>\s,]+)\s*$/);
    if (!m) continue;
    const addr = m[2].toLowerCase();
    const domain = addr.split("@")[1] ?? "";
    let name = m[1].replace(/^"|"$/g, "").replace(/\s+/g, " ").trim();
    if (!name || name.includes("@")) name = nameFromLocal(addr.split("@")[0]);
    if (!name) continue;
    const company = domain === workspaceDomain.toLowerCase() ? "Cirkla" : domain;
    const label = `${name.slice(0, 60)} (${company})`;
    if (!out.includes(label)) out.push(label);
    if (out.length === MAX_PEOPLE) break;
  }
  return out;
}

function nameFromLocal(local: string): string {
  const words = local.split(/[._-]+/).filter((w) => /^[a-z][a-z']+$/i.test(w));
  if (words.length === 0 || words.length > 3) return "";
  return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

/** The per-email message. Contains no email addresses; people appear by name only (headerPeople). */
export function buildUserMessage(p: PromptInput): string {
  const customers = p.customers.map((c) => `- ${c.name} (id ${c.id})`).join("\n");
  const open = p.openFacts.length
    ? p.openFacts.map((f) => `- id ${f.id} · ${f.type} · ${f.date} · ${f.summary}`).join("\n")
    : "- none";
  return [
    `Customer(s) this email is linked to:\n${customers}`,
    `Email date: ${p.date}. Direction: ${
      p.direction === "inbound" ? "sent BY the customer to Cirkla"
      : p.direction === "internal" ? "internal: between Cirkla colleagues about the customer, not sent to the customer"
      : "sent BY Cirkla to the customer"}.`,
    `Earlier open facts for these customers:\n${open}`,
    ...(p.people
      ? [[
          `From (the writer): ${p.people.from.join(", ") || "unknown"}`,
          ...(p.people.to.length ? [`To: ${p.people.to.join(", ")}`] : []),
          ...(p.people.cc.length ? [`Cc: ${p.people.cc.join(", ")}`] : []),
        ].join("\n")]
      : []),
    ...(p.subject ? [`Subject: ${p.subject}`] : []),
    `Email text (cleaned and redacted):\n<<<\n${p.text}\n>>>`,
    ...(p.replyContext ? [`Earlier message (context only; do not quote it):\n<<<\n${p.replyContext}\n>>>`] : []),
  ].join("\n\n");
}
