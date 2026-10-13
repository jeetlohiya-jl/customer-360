/**
 * Minimal RFC 4180 CSV reader: commas, double-quoted fields, "" escapes,
 * CRLF or LF line endings, UTF-8 byte-order mark. No dependencies.
 */
export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvError";
  }
}

export const CSV_LIMITS = { maxBytes: 2 * 1024 * 1024, maxRows: 5000, maxFieldLength: 2000 } as const;

export function parseCsv(text: string): string[][] {
  if (text.length > CSV_LIMITS.maxBytes) throw new CsvError("File is larger than 2 MB.");
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  const endField = () => {
    if (field.length > CSV_LIMITS.maxFieldLength) throw new CsvError(`A field on line ${rows.length + 1} is too long.`);
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0].trim() === "")) rows.push(row);
    row = [];
    if (rows.length > CSV_LIMITS.maxRows + 1) throw new CsvError(`More than ${CSV_LIMITS.maxRows} rows.`);
  };

  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      if (field.trim() !== "") throw new CsvError(`Unexpected quote on line ${rows.length + 1}.`);
      field = "";
      inQuotes = true;
      i++;
    } else if (ch === ",") {
      endField();
      i++;
    } else if (ch === "\r") {
      i++;
    } else if (ch === "\n") {
      endRow();
      i++;
    } else {
      field += ch;
      i++;
    }
  }
  if (inQuotes) throw new CsvError("A quoted field is never closed.");
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/** Splits a multi-value cell ("a; b;; c") into trimmed, de-duplicated values. */
export function splitList(cell: string | undefined): string[] {
  if (!cell) return [];
  const out: string[] = [];
  for (const part of cell.split(";")) {
    const v = part.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}
