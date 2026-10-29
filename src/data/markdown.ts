/**
 * One Markdown table cell from a value: a dash when empty, backslashes escaped before pipes so no value can split a
 * cell or un-escape the separator that follows it.
 */
export function markdownCell(value: string | boolean | null | undefined): string {
  return String(value ?? '—').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}
