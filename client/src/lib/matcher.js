import { ALLERGENS } from '../data/allergens.js';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find allergen mentions in `text`.
 * @param {string} text - extracted ingredient text
 * @param {string[]} selectedIds - allergen ids the user selected
 * @param {{id:string,label:string,terms:string[]}[]} customAllergens - user-defined entries
 * @returns {{allergenId:string,label:string,term:string,index:number,length:number}[]}
 *          non-overlapping matches, sorted by position
 */
export function findMatches(text, selectedIds, customAllergens = []) {
  if (!text || !selectedIds || selectedIds.length === 0) return [];

  const byId = new Map();
  for (const a of ALLERGENS) byId.set(a.id, a);
  for (const c of customAllergens) byId.set(c.id, c);

  const ranges = [];
  for (const id of selectedIds) {
    const allergen = byId.get(id);
    if (!allergen) continue;
    for (const term of allergen.terms) {
      if (!term) continue;
      const re = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'gi');
      let m;
      while ((m = re.exec(text)) !== null) {
        // guard against zero-length matches (shouldn't happen, but safe)
        if (m[0].length === 0) {
          re.lastIndex += 1;
          continue;
        }
        ranges.push({
          allergenId: id,
          label: allergen.label,
          term: m[0],
          index: m.index,
          length: m[0].length,
        });
      }
    }
  }

  // Sort by position; on ties prefer the longest match, then drop overlaps.
  ranges.sort((a, b) => a.index - b.index || b.length - a.length);
  const kept = [];
  let lastEnd = -1;
  for (const r of ranges) {
    if (r.index >= lastEnd) {
      kept.push(r);
      lastEnd = r.index + r.length;
    }
  }
  return kept;
}

/** Unique allergen labels present in a match list, in first-seen order. */
export function matchedLabels(matches) {
  const seen = [];
  for (const m of matches) {
    if (!seen.includes(m.label)) seen.push(m.label);
  }
  return seen;
}
