/**
 * Customer numbers: labels, compact formatting and yearly equivalents.
 * Pure functions, shared by the Numbers page and the Slack assistant.
 */

export const CATEGORY_LABEL: Record<string, string> = {
  production: "Production",
  packaging_usage: "Packaging usage",
  requirement_forecast: "Requirement / forecast",
  order_volume: "Orders",
  spend_price: "Spend / price",
  company_size: "Company size",
  supplier: "Supplier",
};

export const KIND_LABEL: Record<string, string> = {
  actual: "actual", capacity: "capacity", forecast: "forecast", target: "target", estimate: "estimate",
};

/** Working days a year assumed for "per day" figures (5-day weeks); shown wherever it is used. */
export const WORKING_DAYS = 260;
const PER_YEAR: Record<string, number> = { day: WORKING_DAYS, week: 52, month: 12, quarter: 4, year: 1 };

/** The yearly equivalent of a figure with a stated period; null when there is no period (or per shift). */
export function annualize(value: number, period: string): number | null {
  const f = PER_YEAR[period];
  return f === undefined ? null : Math.round(value * f * 1e4) / 1e4;
}

/** 1200000 -> "1.2M", 250000 -> "250K", 0.11 -> "0.11", 6 -> "6". */
export function formatValue(v: number): string {
  const abs = Math.abs(v);
  const trim = (n: number) => String(Math.round(n * 10) / 10);
  if (abs >= 1e9) return `${trim(v / 1e9)}B`;
  if (abs >= 1e6) return `${trim(v / 1e6)}M`;
  if (abs >= 1e4) return `${trim(v / 1e3)}K`;
  return String(Math.round(v * 1e4) / 1e4);
}

export const PERIOD_LABEL: Record<string, string> = {
  day: "per day", week: "per week", month: "per month", quarter: "per quarter", year: "per year", shift: "per shift", none: "",
};

export interface MetricLike {
  value: number | string;
  value_max: number | string | null;
  unit: string | null;
  currency: string | null;
  period: string;
}

/** "250K–300K birds per day", "USD 0.11 per tray". */
export function describeValue(m: MetricLike): string {
  const v = formatValue(Number(m.value));
  const range = m.value_max !== null && m.value_max !== undefined ? `${v}–${formatValue(Number(m.value_max))}` : v;
  const money = m.currency ? `${m.currency} ` : "";
  return [money + range, m.unit, PERIOD_LABEL[m.period] ?? ""].filter(Boolean).join(" ");
}

/** "≈ 65M birds per year" for figures with a period (daily figures assume WORKING_DAYS). */
export function describeYearly(m: MetricLike): string | null {
  if (m.period === "year") return null;
  const y = annualize(Number(m.value), m.period);
  if (y === null) return null;
  const yMax = m.value_max !== null && m.value_max !== undefined ? annualize(Number(m.value_max), m.period) : null;
  const range = yMax !== null ? `${formatValue(y)}–${formatValue(yMax)}` : formatValue(y);
  return `≈ ${m.currency ? `${m.currency} ` : ""}${range}${m.unit ? ` ${m.unit}` : ""} per year${m.period === "day" ? ` (${WORKING_DAYS} working days)` : ""}`;
}
