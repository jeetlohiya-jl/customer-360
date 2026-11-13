import { annualize } from "./format";

export interface MetricRow {
  metric_id: string;
  customer_id: string;
  customer_name: string;
  category: string;
  metric: string;
  value: number | string;
  value_max: number | string | null;
  unit: string | null;
  currency: string | null;
  period: string;
  scope: string | null;
  kind: string;
  as_of: string | null;
  party: string;
  summary: string;
  evidence_quote: string | null;
  confidence: number | string;
  review_state: string;
  message_at: string;
  direction: string;
  is_mine: boolean;
  gmail_message_id: string | null;
  mailbox_email: string | null;
}

export interface MetricGroup {
  key: string;
  latest: MetricRow;
  earlier: MetricRow[];
  /** An earlier figure for the same thing differs from the latest by more than 20% (compared per year when periods differ). */
  conflict: MetricRow | null;
}

const norm = (s: string | null) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Comparable size: yearly when a period is stated, else the value itself (only compared with the same period). */
function comparable(r: MetricRow): { v: number; basis: string } {
  const y = annualize(Number(r.value), r.period);
  return y === null ? { v: Number(r.value), basis: r.period } : { v: y, basis: "year" };
}

/**
 * Groups numbers about the same thing (customer, category, measure, scope, kind,
 * unit and currency): the newest is shown, older ones are history, and a
 * disagreement between them is flagged. Rows arrive in any order.
 */
export function groupMetrics(rows: MetricRow[]): MetricGroup[] {
  const groups = new Map<string, MetricRow[]>();
  for (const r of rows) {
    const key = [r.customer_id, r.category, norm(r.metric), norm(r.scope), r.kind, norm(r.unit), r.currency ?? ""].join("|");
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: MetricGroup[] = [];
  for (const [key, list] of groups) {
    const sorted = [...list].sort((a, b) => b.message_at.localeCompare(a.message_at));
    const [latest, ...earlier] = sorted;
    const a = comparable(latest);
    const conflict = earlier.find((e) => {
      const b = comparable(e);
      if (a.basis !== b.basis || b.v === 0) return false;
      return Math.abs(a.v - b.v) / Math.max(a.v, b.v) > 0.2;
    }) ?? null;
    out.push({ key, latest, earlier, conflict });
  }
  return out.sort((x, y) => x.latest.customer_name.localeCompare(y.latest.customer_name)
    || x.latest.category.localeCompare(y.latest.category) || y.latest.message_at.localeCompare(x.latest.message_at));
}
