/**
 * ID generation.
 *
 * IDs are opaque, URL-safe, sortable-ish strings. They are generated in the
 * browser so that records can be created offline and later reconciled with the
 * cloud without an ID remapping step.
 */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomChars(len) {
  const bytes = new Uint8Array(len);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < len; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < len; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** Monotonic-ish time component keeps chronological sorting stable. */
const timePart = () => Date.now().toString(36);

/**
 * @param {string} [prefix] short namespace, e.g. "txn"
 * @returns {string} e.g. "txn_m3k9x1_a7f2q8"
 */
export function uid(prefix = 'id') {
  return `${prefix}_${timePart()}_${randomChars(6)}`;
}

export const ids = {
  transaction: () => uid('txn'),
  category: () => uid('cat'),
  account: () => uid('acc'),
  budget: () => uid('bud'),
  recurring: () => uid('rec'),
  goal: () => uid('goal'),
  contribution: () => uid('gc'),
  occurrence: (ruleId, isoDate) => `${ruleId}:${isoDate}`
};

/**
 * Deterministic idempotency key for a recurring occurrence. Re-using the same
 * key for the same rule + due date is what prevents duplicate generation.
 */
export function occurrenceKey(ruleId, isoDate) {
  return ids.occurrence(ruleId, isoDate);
}

/** Collision-safe filename suffix for exports. */
export function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
