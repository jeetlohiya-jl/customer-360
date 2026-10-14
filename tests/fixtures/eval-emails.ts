/**
 * Extra SYNTHETIC emails used only by the paid live evaluation
 * (tests/eval/extract.eval.test.ts). Invented companies, people and numbers.
 * Each lists the facts a correct extractor should store (type + stance [+ status]).
 * The tricky ones test requests vs commitments, forecasts vs orders,
 * negotiations, partial changes, cancellations and resolutions.
 */
export interface EvalEmail {
  name: string;
  direction: "inbound" | "outbound";
  body: string;
  labels: { fact_type: string; stance: string; status?: string }[];
}

export const EVAL_EMAILS: EvalEmail[] = [
  { name: "two-quotes-and-samples", direction: "inbound", body: "Hi Ravi,\n\nCould you quote the 8x6 and the 9x6 trays at 50,000 units each? Also please send 20 samples of each for our line trial.\n\nPriya", labels: [{ fact_type: "pricing", stance: "request" }, { fact_type: "follow_up", stance: "request" }] },
  { name: "cirkla-accepts-po", direction: "outbound", body: "Hi Priya,\n\nWe have received PO 5521 and confirm 8,000 cases of 8x6 trays, shipping from Mundra on December 2.\n\nRavi", labels: [{ fact_type: "order", stance: "commitment" }, { fact_type: "delivery", stance: "commitment" }] },
  { name: "cracking-complaint", direction: "inbound", body: "Ravi,\n\nTrays from lot 118 are cracking at the sealing station; two pallets are affected. Please issue a credit for those pallets.\n\nPriya", labels: [{ fact_type: "quality_issue", stance: "report", status: "open" }, { fact_type: "follow_up", stance: "request" }] },
  { name: "forecast-not-order", direction: "inbound", body: "Hi Ravi,\n\nFor planning only: we expect to need around 40,000 trays a month in Q2. Nothing is firm yet.\n\nPriya", labels: [{ fact_type: "requirement", stance: "report" }] },
  { name: "price-negotiation", direction: "inbound", body: "Ravi,\n\nCan you do $0.19 per tray if we commit to 100,000 trays this year?\n\nPriya", labels: [{ fact_type: "pricing", stance: "request" }] },
  { name: "price-accepted", direction: "inbound", body: "Ravi,\n\nOK, go ahead at $0.20 per tray for the 100,000 trays. PO to follow this week.\n\nPriya", labels: [{ fact_type: "pricing", stance: "commitment" }] },
  { name: "vessel-delay", direction: "outbound", body: "Hi Priya,\n\nThe container for PO 5521 rolled to the next vessel. New ETA at Savannah is January 8.\n\nRavi", labels: [{ fact_type: "delivery", stance: "report" }] },
  { name: "push-out-request", direction: "inbound", body: "Ravi,\n\nPlease move the delivery for PO 5521 from December 2 to December 16, our cold store is full.\n\nPriya", labels: [{ fact_type: "delivery", stance: "request" }] },
  { name: "push-out-agreed", direction: "outbound", body: "Priya,\n\nConfirmed, we will deliver PO 5521 on December 16 instead.\n\nRavi", labels: [{ fact_type: "delivery", stance: "commitment" }] },
  { name: "reduce-order", direction: "inbound", body: "Ravi,\n\nPlease cut PO 5521 from 8,000 to 5,000 cases. Sorry for the late change.\n\nPriya", labels: [{ fact_type: "order", stance: "request" }] },
  { name: "claim-closed", direction: "inbound", body: "Ravi,\n\nThe replacement for lot 118 passed our QA today, so we are closing the claim.\n\nPriya", labels: [{ fact_type: "quality_issue", stance: "report", status: "resolved" }] },
  { name: "customer-promises-artwork", direction: "inbound", body: "Ravi,\n\nI will send the final artwork files for the printed trays by Friday.\n\nPriya", labels: [{ fact_type: "follow_up", stance: "commitment" }] },
  { name: "spec-requirement", direction: "inbound", body: "Hi Ravi,\n\nThe tray must hold 2 lb of ground beef with an absorbent pad and fit our 9x6 overwrap film.\n\nPriya", labels: [{ fact_type: "requirement", stance: "report" }] },
  { name: "competitor-price", direction: "inbound", body: "Ravi,\n\nFYI, another supplier offered us $0.17 per tray for the same spec.\n\nPriya", labels: [{ fact_type: "pricing", stance: "report" }] },
  { name: "po-asap", direction: "inbound", body: "Hi Ravi,\n\nPO 6610 attached for 1,200 cases of 9x6. Please ship as soon as possible.\n\nPriya", labels: [{ fact_type: "order", stance: "commitment" }] },
  { name: "no-facts", direction: "inbound", body: "Hi Ravi,\n\nGreat meeting you at the expo last week! Let's catch up when you are next in Chicago.\n\nPriya", labels: [] },
  { name: "chasing-samples", direction: "inbound", body: "Hi Ravi,\n\nAny update on the samples you promised last month? Our trial is next week.\n\nPriya", labels: [{ fact_type: "follow_up", stance: "request", status: "open" }] },
  { name: "proposed-schedule", direction: "outbound", body: "Hi Priya,\n\nWe propose four shipments of 25,000 trays each, starting in February, one per month.\n\nRavi", labels: [{ fact_type: "delivery", stance: "proposal" }] },
  { name: "full-cancellation", direction: "inbound", body: "Ravi,\n\nWe are cancelling PO 7002 entirely; the program has been dropped.\n\nPriya", labels: [{ fact_type: "order", stance: "cancellation", status: "cancelled" }] },
  { name: "hinglish-acceptance", direction: "inbound", body: "Ravi ji,\n\nPrice theek hai. Please send the PI for 50,000 trays so we can release payment.\n\nAnil", labels: [{ fact_type: "pricing", stance: "commitment" }, { fact_type: "follow_up", stance: "request" }] },
];
