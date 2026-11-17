/** Text made safe for the markup of an exported file. */
const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ENTITIES[character]);
}

/** XML 1.0 has no place for most control characters: they are dropped. */
export function escapeXml(text: string): string {
  // eslint-disable-next-line no-control-regex
  return escapeHtml(text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''));
}

/** A Markdown table cell: pipes escaped and lines joined. */
export function markdownCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
