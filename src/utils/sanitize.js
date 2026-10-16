/**
 * Escaping + sanitising helpers.
 *
 * The application renders user-controlled text with `textContent` wherever
 * possible. When string HTML is unavoidable (icon placeholders, tiny static
 * snippets) all interpolated values must pass through `escapeHtml`.
 */

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;'
};

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"'`]/g, (ch) => HTML_ESCAPES[ch]);
}

/**
 * Characters that spreadsheet programs may interpret as the start of a formula.
 * See OWASP "CSV Injection".
 */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r', '\u0009', '\u000d', '\u2028', '\u2029'];

/**
 * Escapes a single CSV cell: RFC 4180 quoting plus formula-injection
 * neutralisation by prefixing a single quote when the value could be executed.
 */
export function escapeCsvCell(value) {
  if (value === null || value === undefined) return '';
  let str = typeof value === 'string' ? value : String(value);
  // Neutralise formulas before quoting: a leading (or leading-whitespace then
  // formula) character would be executed by Excel / Sheets / LibreOffice.
  if (str.length > 0) {
    if (FORMULA_PREFIXES.includes(str[0]) || (/^[=+\-@]/.test(str.trimStart()) && str.trimStart() !== str)) {
      str = `'${str}`;
    }
  }
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Serialises rows to a CSV document (CRLF line endings, UTF-8 BOM added by caller). */
export function toCsv(rows) {
  return rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n');
}

/** Strips control characters and enforces a maximum length. */
export function sanitizeText(value, maxLength = 500) {
  if (value === null || value === undefined) return '';
  let str = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  str = str.replace(/\r\n?/g, '\n').trim();
  if (str.length > maxLength) str = str.slice(0, maxLength);
  return str;
}

/** Single-line variant used for names, payees and titles. */
export function sanitizeLine(value, maxLength = 120) {
  return sanitizeText(value, maxLength).replace(/\s*\n\s*/g, ' ').trim();
}

/**
 * JSON.parse that never throws and rejects obviously dangerous payload shapes.
 * @returns {{ok:true,value:any}|{ok:false,error:string}}
 */
export function safeJsonParse(text, { maxBytes = 25 * 1024 * 1024 } = {}) {
  if (typeof text !== 'string') return { ok: false, error: 'Expected a text payload.' };
  if (text.length > maxBytes) return { ok: false, error: 'The file is larger than the allowed limit.' };
  try {
    const value = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false, error: 'The file is not valid JSON.' };
  }
}

/** Query-string escaping for CSV/HTML attribute use. */
export function encodeAttr(value) {
  return escapeHtml(value);
}

/** Filesystem-safe download name. */
export function sanitizeFilename(name, fallback = 'spendwise-export') {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 120);
  return cleaned || fallback;
}

/** Validates that a string is a safe hex colour. */
export function sanitizeColor(value, fallback = '#6366f1') {
  const str = String(value || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(str)) return str.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(str)) {
    return `#${str[1]}${str[1]}${str[2]}${str[2]}${str[3]}${str[3]}`.toLowerCase();
  }
  return fallback;
}

const NAME_RE = /^[a-z0-9-]+$/;

/** Whitelists an icon name (lucide kebab-case). */
export function sanitizeIconName(value, fallback = 'tag') {
  const str = String(value || '').trim().toLowerCase();
  return NAME_RE.test(str) && str.length <= 40 ? str : fallback;
}
