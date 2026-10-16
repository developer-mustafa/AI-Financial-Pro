/**
 * Category domain service.
 *
 * Safety rules implemented here (and mirrored in the UI):
 *  - names must be unique among non-archived siblings of the same type,
 *  - a category referenced by transactions can never be deleted, only archived,
 *  - archived categories stay attached to historical transactions and keep
 *    rendering with their original name/colour,
 *  - new transactions cannot be assigned to an archived category
 *    (enforced by the transaction validator),
 *  - renaming or recolouring never rewrites history — reports resolve names
 *    through this service at render time.
 */

import { store as defaultStore, RESOURCES } from '../../core/state.js';
import { ids } from '../../utils/ids.js';
import { nowISO } from '../../utils/date.js';
import { validateCategory } from '../../utils/validation.js';
import { eligibleTransactions } from '../../utils/calculations.js';
import { DEFAULT_INCOME_CATEGORY_NAMES, DEFAULT_EXPENSE_CATEGORY_NAMES } from '../../config/defaults.js';

export function createCategoryService({ store = defaultStore } = {}) {
  const all = () => store.list(RESOURCES.CATEGORIES);

  function validate(input, { excludeId = null } = {}) {
    return validateCategory(input, { categories: all(), excludeId });
  }

  return {
    all,
    active: (type = null) => all().filter((category) => !category.archived && (!type || category.type === type)),
    ordered: (type = null) => store.orderedCategories(type),
    get: (id) => store.byId(RESOURCES.CATEGORIES, id),

    add(input) {
      const result = validate(input);
      if (!result.ok) return { ok: false, errors: result.errors };
      const record = { ...result.value, id: result.value.id || ids.category(), createdAt: nowISO(), updatedAt: nowISO() };
      store.apply('category:add', (draft) => {
        draft.categories = [...draft.categories, record];
        return [{ resource: RESOURCES.CATEGORIES, op: 'upsert', record }];
      });
      return { ok: true, record };
    },

    update(id, input) {
      const existing = store.byId(RESOURCES.CATEGORIES, id);
      if (!existing) return { ok: false, errors: { id: 'That category no longer exists.' } };
      const result = validate({ ...existing, ...input, id }, { excludeId: id });
      if (!result.ok) return { ok: false, errors: result.errors };
      const record = { ...result.value, id, createdAt: existing.createdAt, isDefault: existing.isDefault, updatedAt: nowISO() };
      store.apply('category:update', (draft) => {
        draft.categories = draft.categories.map((category) => (category.id === id ? record : category));
        return [{ resource: RESOURCES.CATEGORIES, op: 'upsert', record }];
      });
      return { ok: true, record };
    },

    /** Archiving hides a category from new entries but keeps history intact. */
    archive(id) {
      const existing = store.byId(RESOURCES.CATEGORIES, id);
      if (!existing) return { ok: false, errors: { id: 'That category no longer exists.' } };
      if (existing.archived) return { ok: true, record: existing };
      return this.update(id, { ...existing, archived: true });
    },

    /**
     * Restoring an archived category refuses to create a duplicate: if an
     * active category with the same name/type/level exists, the operation is
     * rejected with an explanatory message instead of silently duplicating.
     */
    restore(id) {
      const existing = store.byId(RESOURCES.CATEGORIES, id);
      if (!existing) return { ok: false, errors: { id: 'That category no longer exists.' } };
      const clash = all().find(
        (category) =>
          category.id !== id &&
          !category.archived &&
          category.type === existing.type &&
          (category.parentId || null) === (existing.parentId || null) &&
          category.name.trim().toLowerCase() === existing.name.trim().toLowerCase()
      );
      if (clash) {
        return {
          ok: false,
          errors: { name: `An active category named “${clash.name}” already exists at this level. Rename one of them first.` }
        };
      }
      return this.update(id, { ...existing, archived: false });
    },

    /** Hard delete — only allowed for categories with no transaction history. */
    remove(id) {
      const existing = store.byId(RESOURCES.CATEGORIES, id);
      if (!existing) return { ok: false, errors: { id: 'That category no longer exists.' } };
      const usage = this.usageCount(id);
      if (usage > 0) {
        return {
          ok: false,
          errors: { id: `This category is used by ${usage} transaction${usage === 1 ? '' : 's'}. Archive it instead — history must keep its category.` }
        };
      }
      const children = all().filter((category) => category.parentId === id);
      if (children.length > 0) {
        return { ok: false, errors: { id: `This category has ${children.length} subcategor${children.length === 1 ? 'y' : 'ies'}. Move or delete them first.` } };
      }
      store.apply('category:delete', (draft) => {
        draft.categories = draft.categories.filter((category) => category.id !== id);
        return [{ resource: RESOURCES.CATEGORIES, op: 'delete', id }];
      });
      return { ok: true, record: existing };
    },

    usageCount(id) {
      return store.list(RESOURCES.TRANSACTIONS).filter((tx) => tx.categoryId === id).length;
    },

    children: (id) => all().filter((category) => category.parentId === id),

    descendants(id) {
      const out = [];
      const queue = [id];
      const seen = new Set();
      while (queue.length) {
        const current = queue.shift();
        for (const child of all().filter((category) => category.parentId === current)) {
          if (seen.has(child.id)) continue;
          seen.add(child.id);
          out.push(child);
          queue.push(child.id);
        }
      }
      return out;
    },

    parentOptions(type, excludeId = null) {
      const blocked = new Set(excludeId ? [excludeId, ...this.descendants(excludeId).map((category) => category.id)] : []);
      return store.orderedCategories(type)
        .filter((category) => !blocked.has(category.id) && category.depth < 3)
        .map((category) => ({ value: category.id, label: `${'— '.repeat(category.depth)}${category.name}` }));
    },

    /**
     * Per-category totals. @returns {Map<string, {count:number, incomeMinor:number, expenseMinor:number}>}
     */
    stats({ from = null, to = null, includePending = false } = {}) {
      const map = new Map();
      for (const tx of eligibleTransactions(store.list(RESOURCES.TRANSACTIONS), { from, to, includePending })) {
        if (!tx.categoryId) continue;
        const entry = map.get(tx.categoryId) || { count: 0, incomeMinor: 0, expenseMinor: 0 };
        entry.count += 1;
        if (tx.type === 'income') entry.incomeMinor += tx.amountMinor;
        else if (tx.type === 'expense') entry.expenseMinor += tx.amountMinor;
        map.set(tx.categoryId, entry);
      }
      // Roll child totals up into their parents for the tree view.
      const rolled = new Map();
      for (const [id, value] of map) {
        let cursor = all().find((category) => category.id === id);
        const seen = new Set();
        while (cursor) {
          if (seen.has(cursor.id)) break;
          seen.add(cursor.id);
          const entry = rolled.get(cursor.id) || { count: 0, incomeMinor: 0, expenseMinor: 0, directCount: 0 };
          entry.count += value.count;
          entry.incomeMinor += value.incomeMinor;
          entry.expenseMinor += value.expenseMinor;
          if (cursor.id === id) entry.directCount += value.count;
          rolled.set(cursor.id, entry);
          cursor = cursor.parentId ? all().find((category) => category.id === cursor.parentId) : null;
        }
      }
      return rolled;
    },

    duplicates() {
      const seen = new Map();
      const clashes = [];
      for (const category of all()) {
        const key = `${category.type}::${category.parentId || ''}::${category.name.trim().toLowerCase()}`;
        if (seen.has(key)) clashes.push([seen.get(key), category]);
        else seen.set(key, category);
      }
      return clashes;
    },

    /** Reseeds any missing built-in category names without touching the rest. */
    ensureDefaults() {
      return store.restoreDefaults();
    },

    defaultNames: { income: DEFAULT_INCOME_CATEGORY_NAMES, expense: DEFAULT_EXPENSE_CATEGORY_NAMES }
  };
}
