import { parse } from 'csv-parse/sync';

export type Row = Record<string, string>;

export interface Table {
  headers: string[];
  rows: Row[];
}

export function parseCsv(text: string): Table {
  const records = parse(text, { bom: true, relax_column_count: false, skip_empty_lines: true });
  const [headers, ...body] = records;
  if (!headers) throw new Error('CSV has no header row');
  const rows = body.map((values) => {
    const row: Row = {};
    headers.forEach((h, i) => { row[h] = values[i] ?? ''; });
    return row;
  });
  return { headers, rows };
}

function quote(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** RFC 4180 output, LF line endings, no BOM, quoting only when required. */
export function serializeCsv(table: Table): string {
  const lines = [table.headers.map(quote).join(',')];
  for (const row of table.rows) lines.push(table.headers.map((h) => quote(row[h] ?? '')).join(','));
  return lines.join('\n') + '\n';
}
