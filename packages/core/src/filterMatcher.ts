// sift default export = createDefaultQueryTester — includes ALL MongoDB operators
// ($eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $or, $and, $nor, $not, $exists, $regex, …).
// The cast works around a NodeNext CJS/ESM interop limitation where TypeScript infers
// the import type as `typeof module` instead of the callable default export.
import sift from "sift";
type SiftTester = (filter: Record<string, unknown>) => (record: Record<string, unknown>) => boolean;
const testRecord = sift as unknown as SiftTester;
import { simplify } from "@sync-subscribe/mongo-selector-simplifier";
import type { SubscriptionFilter } from "./types.js";

/**
 * Simplifies a filter using algebraic rules (deduplication, absorption, De Morgan's, etc.).
 * Always call this after building composite filters (negation, union, intersection)
 * to keep stored and compared filters in a canonical form.
 */
export function simplifyFilter(filter: SubscriptionFilter): SubscriptionFilter {
  return simplify(filter as Record<string, unknown>) as SubscriptionFilter;
}

/**
 * Returns the logical negation of a filter.
 * Uses De Morgan's laws and operator inversions so the result is always a valid
 * SubscriptionFilter (no $nor — the simplifier cannot parse it). The output is
 * simplified before being returned.
 *
 * @example
 * negateFilter({ color: "blue" })               // → { color: { $ne: "blue" } }
 * negateFilter({ $or: [{ a: 1 }, { b: 2 }] })  // → { $and: [{ a: { $ne: 1 } }, { b: { $ne: 2 } }] }
 * negateFilter({})                              // → { $or: [] }  (never matches)
 */
export function negateFilter(filter: SubscriptionFilter): SubscriptionFilter {
  return simplifyFilter(_negate(filter));
}

function _negate(filter: SubscriptionFilter): SubscriptionFilter {
  const f = filter as Record<string, unknown>;
  const keys = Object.keys(f);

  if (keys.length === 0) {
    // {} matches everything — negation matches nothing; { $or: [] } is canonical always-false
    return { $or: [] };
  }

  // $or: [A, B] → $and: [NOT A, NOT B]  (De Morgan's — avoids $nor which the simplifier rejects)
  if (keys.length === 1 && keys[0] === "$or") {
    return { $and: (f["$or"] as SubscriptionFilter[]).map(_negate) };
  }

  // $nor: [A, B] → $or: [A, B]  (double negation: NOT NOR(A,B) = A OR B)
  if (keys.length === 1 && keys[0] === "$nor") {
    return { $or: f["$nor"] as SubscriptionFilter[] };
  }

  // $and: [A, B] → $or: [NOT A, NOT B]  (De Morgan's)
  if (keys.length === 1 && keys[0] === "$and") {
    return { $or: (f["$and"] as SubscriptionFilter[]).map(_negate) };
  }

  // Single field condition
  if (keys.length === 1) {
    const key = keys[0]!;
    return _negateFieldCondition(key, f[key]);
  }

  // Implicit AND of multiple field conditions → $or of negated conditions (De Morgan's)
  return { $or: keys.map((k) => _negateFieldCondition(k, f[k]) as SubscriptionFilter) };
}

/**
 * Negate a single field+value pair.
 * For multi-operator values like { $gte: 1, $lte: 5 }, De Morgan's gives:
 *   NOT(x>=1 AND x<=5) = (x<1) OR (x>5)  → top-level $or with per-op negations.
 */
function _negateFieldCondition(key: string, val: unknown): SubscriptionFilter {
  if (typeof val === "object" && val !== null && !Array.isArray(val)) {
    const ops = Object.keys(val as object);
    if (ops.length > 1) {
      // Multiple operators on one field → negate each and OR them
      return {
        $or: ops.map((op) => ({
          [key]: _negateCondition({ [op]: (val as Record<string, unknown>)[op] }),
        })),
      } as SubscriptionFilter;
    }
  }
  return { [key]: _negateCondition(val) } as SubscriptionFilter;
}

function _negateCondition(condition: unknown): unknown {
  if (condition === null || typeof condition !== "object" || Array.isArray(condition)) {
    // Primitive / null → implicit $eq → negate to $ne
    return { $ne: condition };
  }

  const c = condition as Record<string, unknown>;

  // Single well-known operator inversions
  if ("$eq" in c)     return { $ne: c["$eq"] };
  if ("$ne" in c)     return { $eq: c["$ne"] };
  if ("$gt" in c)     return { $lte: c["$gt"] };
  if ("$gte" in c)    return { $lt: c["$gte"] };
  if ("$lt" in c)     return { $gte: c["$lt"] };
  if ("$lte" in c)    return { $gt: c["$lte"] };
  if ("$in" in c)     return { $nin: c["$in"] };
  if ("$nin" in c)    return { $in: c["$nin"] };
  if ("$exists" in c) return { $exists: !(c["$exists"] as boolean) };

  // Fallback for unrecognised expressions
  return { $not: condition };
}

/**
 * Returns true if the filter is logically unsatisfiable — i.e., it can never
 * match any record, regardless of local data. Works on the raw filter structure
 * without calling simplifyFilter (the simplifier can destroy contradictions by
 * preferring one branch, e.g. collapsing { $and: [{x:1},{x:{$ne:1}}] } to {x:1}).
 *
 * Detects:
 *  - { $or: [] }                              — OR of nothing
 *  - { field: { $in: [] } }                   — empty membership set
 *  - { field: { $in: [A], $nin: [A] } }       — in/nin fully overlapping
 *  - { $and: [{x:1},{x:{$ne:1}}] }            — cross-branch field contradiction
 *  - { $and: [...] } / { $or: [...] }         — recursive structural checks
 *  - Numeric range: { $gte: 5 } AND { $lt: 3 } across branches
 */
export function isAlwaysFalse(filter: SubscriptionFilter): boolean {
  return _isAlwaysFalse(filter as Record<string, unknown>);
}

function _isAlwaysFalse(f: Record<string, unknown>): boolean {
  // { $or: [] } — OR of nothing = false
  if (Array.isArray(f["$or"]) && (f["$or"] as unknown[]).length === 0) return true;

  // { $and: [...] } — false if any child is always false, OR if cross-branch field
  // constraints are contradictory. Flatten nested $and nodes first so that
  // { $and: [A, { $and: [B, C] }] } is treated identically to { $and: [A, B, C] }.
  if (Array.isArray(f["$and"])) {
    const branches = _flattenAnd(f["$and"] as Record<string, unknown>[]);
    if (branches.some((c) => _isAlwaysFalse(c))) return true;
    if (_andBranchesContradictory(branches)) return true;
  }

  // { $or: [...] } — false if every child is always false
  if (Array.isArray(f["$or"]) && (f["$or"] as unknown[]).length > 0) {
    if ((f["$or"] as unknown[]).every((c) => _isAlwaysFalse(c as Record<string, unknown>))) return true;
  }

  // Top-level field constraints — check each field's condition object for contradiction
  for (const [key, val] of Object.entries(f)) {
    if (key.startsWith("$")) continue;
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      if (_fieldConditionContradictory(val as Record<string, unknown>)) return true;
    }
  }

  return false;
}

/**
 * Checks a single field's merged operator object for internal contradiction.
 * e.g. { $in: [] }, { $eq: 1, $ne: 1 }, { $gte: 5, $lt: 3 }
 */
function _fieldConditionContradictory(c: Record<string, unknown>): boolean {
  // { $in: [] } — empty membership set
  if (Array.isArray(c["$in"]) && (c["$in"] as unknown[]).length === 0) return true;

  // { $eq: X, $ne: X }
  if ("$eq" in c && "$ne" in c && JSON.stringify(c["$eq"]) === JSON.stringify(c["$ne"])) return true;

  // { $in: [A,B], $nin: [A,B] } — $nin covers every value in $in
  if (Array.isArray(c["$in"]) && Array.isArray(c["$nin"])) {
    const inVals = (c["$in"] as unknown[]).map((v) => JSON.stringify(v));
    const ninSet = new Set((c["$nin"] as unknown[]).map((v) => JSON.stringify(v)));
    if (inVals.every((v) => ninSet.has(v))) return true;
  }

  // Numeric range: check if the effective range is empty
  return _numericRangeEmpty([c]);
}

/**
 * Flatten nested { $and: [...] } branches into a single flat array.
 * e.g. [A, { $and: [B, C] }, D] → [A, B, C, D]
 */
function _flattenAnd(branches: Record<string, unknown>[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const b of branches) {
    if (Array.isArray(b["$and"])) {
      result.push(..._flattenAnd(b["$and"] as Record<string, unknown>[]));
    } else {
      result.push(b);
    }
  }
  return result;
}

/**
 * Checks whether the conjunction of `branches` is always-false.
 *
 * Two strategies applied after flattening nested $and nodes:
 *  1. Direct: collect per-field constraints and check for contradiction.
 *  2. Case-split: for each { $or: [A, B, ...] } branch, verify that every
 *     alternative is contradictory with the remaining branches.
 *
 * Example: { $and: [{x:1, y:1}, { $or: [{x:{$ne:1}}, {y:{$ne:1}}] }] }
 *  → case-split on the $or:
 *    - [{x:1,y:1}, {x:{$ne:1}}] → direct contradiction
 *    - [{x:1,y:1}, {y:{$ne:1}}] → direct contradiction
 *  → all alternatives contradictory → always-false.
 *
 * Supports multi-level: negated unions produce { $and: [{$or:...},{$or:...}] }
 * which is flattened then case-split recursively.
 */
function _andBranchesContradictory(branches: Record<string, unknown>[]): boolean {
  // Flatten nested $and first so { $and: [{$or:A},{$or:B}] } expands correctly
  const flat = _flattenAnd(branches);

  const fieldBranches: Record<string, unknown>[] = [];
  const orBranches: Record<string, unknown>[][] = [];

  for (const branch of flat) {
    if (Array.isArray(branch["$or"])) {
      orBranches.push(branch["$or"] as Record<string, unknown>[]);
    } else {
      fieldBranches.push(branch);
    }
  }

  // Strategy 1: direct field contradiction among flat (non-$or) branches
  const byField = new Map<string, unknown[]>();
  for (const branch of fieldBranches) {
    for (const [key, val] of Object.entries(branch)) {
      if (key.startsWith("$")) continue;
      if (!byField.has(key)) byField.set(key, []);
      byField.get(key)!.push(val);
    }
  }
  for (const [, conditions] of byField) {
    if (_fieldValuesContradictory(conditions)) return true;
  }

  // Strategy 2: case-split on each $or branch in order.
  // For a given $or, if every alternative combined with all OTHER branches is
  // always-false, then the whole conjunction is always-false.
  for (let i = 0; i < orBranches.length; i++) {
    const alternatives = orBranches[i]!;
    const otherOrBranches = orBranches.filter((_, j) => j !== i).map(
      (alts) => ({ $or: alts }) as Record<string, unknown>,
    );
    if (
      alternatives.every((alt) =>
        _andBranchesContradictory([
          ...fieldBranches,
          ...otherOrBranches,
          alt as Record<string, unknown>,
        ]),
      )
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Given a list of values/condition-objects for the same field (from different $and branches),
 * returns true if they cannot all be satisfied simultaneously.
 */
function _fieldValuesContradictory(conditions: unknown[]): boolean {
  const eqValues: string[] = [];  // JSON.stringify'd
  const neValues: string[] = [];
  let inSet: string[] | null = null; // JSON.stringify'd; null = unconstrained
  const ninValues: string[] = [];
  const condObjects: Record<string, unknown>[] = [];

  for (const cond of conditions) {
    if (typeof cond !== "object" || cond === null || Array.isArray(cond)) {
      eqValues.push(JSON.stringify(cond)); // primitive equality
    } else {
      const c = cond as Record<string, unknown>;
      condObjects.push(c);
      if ("$eq" in c) eqValues.push(JSON.stringify(c["$eq"]));
      if ("$ne" in c) neValues.push(JSON.stringify(c["$ne"]));
      if ("$in" in c && Array.isArray(c["$in"])) {
        const vals = (c["$in"] as unknown[]).map((v) => JSON.stringify(v));
        inSet = inSet === null ? vals : inSet.filter((v) => vals.includes(v));
      }
      if ("$nin" in c && Array.isArray(c["$nin"])) {
        ninValues.push(...(c["$nin"] as unknown[]).map((v) => JSON.stringify(v)));
      }
    }
  }

  // Conflicting equality values (e.g. x=1 and x=2)
  const uniqueEq = new Set(eqValues);
  if (uniqueEq.size > 1) return true;

  // Equality + matching $ne (e.g. x=1 and x≠1)
  for (const eq of eqValues) {
    if (neValues.includes(eq)) return true;
  }

  // Equality + $nin covering that value (e.g. x="work" and x ∉ {"work","personal"})
  for (const eq of eqValues) {
    if (ninValues.includes(eq)) return true;
  }

  // $in set empties out after applying $ne / $nin / equality constraints
  if (inSet !== null) {
    let remaining = inSet.filter((v) => !neValues.includes(v) && !ninValues.includes(v));
    if (eqValues.length > 0) {
      remaining = remaining.filter((v) => eqValues.includes(v));
    }
    if (remaining.length === 0) return true;
  }

  // Numeric range analysis across all condition objects
  if (_numericRangeEmpty(condObjects)) return true;

  return false;
}

type RangeBound = { val: number; inclusive: boolean };

function _maxLower(a: RangeBound, b: RangeBound): RangeBound {
  if (a.val !== b.val) return a.val > b.val ? a : b;
  return a.inclusive ? b : a; // exclusive is more restrictive at same value
}

function _minUpper(a: RangeBound, b: RangeBound): RangeBound {
  if (a.val !== b.val) return a.val < b.val ? a : b;
  return a.inclusive ? b : a; // exclusive is more restrictive at same value
}

/**
 * Returns true if the combined $gt/$gte/$lt/$lte constraints in a list of condition
 * objects describe an empty numeric range.
 */
function _numericRangeEmpty(conds: Record<string, unknown>[]): boolean {
  let lower: RangeBound | null = null;
  let upper: RangeBound | null = null;

  for (const c of conds) {
    if (typeof c["$gt"] === "number") {
      const b: RangeBound = { val: c["$gt"] as number, inclusive: false };
      lower = lower ? _maxLower(lower, b) : b;
    }
    if (typeof c["$gte"] === "number") {
      const b: RangeBound = { val: c["$gte"] as number, inclusive: true };
      lower = lower ? _maxLower(lower, b) : b;
    }
    if (typeof c["$lt"] === "number") {
      const b: RangeBound = { val: c["$lt"] as number, inclusive: false };
      upper = upper ? _minUpper(upper, b) : b;
    }
    if (typeof c["$lte"] === "number") {
      const b: RangeBound = { val: c["$lte"] as number, inclusive: true };
      upper = upper ? _minUpper(upper, b) : b;
    }
  }

  if (!lower || !upper) return false;
  if (lower.val > upper.val) return true;
  if (lower.val === upper.val && (!lower.inclusive || !upper.inclusive)) return true;
  return false;
}

export interface FilterDiff {
  unchanged: boolean;
  added: Record<string, unknown>;
  removed: Record<string, unknown>;
  changed: Record<string, { from: unknown; to: unknown }>;
}

/** Returns true if two filters are semantically equal (compared after simplification). */
export function filtersEqual(
  a: SubscriptionFilter,
  b: SubscriptionFilter,
): boolean {
  return JSON.stringify(simplifyFilter(a)) === JSON.stringify(simplifyFilter(b));
}

/**
 * Returns true if the record satisfies every condition in the filter.
 * Delegates to sift for full MongoDB-style query support.
 */
export function matchesFilter(
  record: Record<string, unknown>,
  filter: SubscriptionFilter,
): boolean {
  return testRecord(filter as Record<string, unknown>)(record);
}

/**
 * Computes the diff between two filters — which conditions were added, removed, or changed.
 * Returns `unchanged: true` when both filters are deeply equal.
 */
export function filterDiff(
  oldFilter: SubscriptionFilter,
  newFilter: SubscriptionFilter,
): FilterDiff {
  const a = oldFilter as Record<string, unknown>;
  const b = newFilter as Record<string, unknown>;
  const added: Record<string, unknown> = {};
  const removed: Record<string, unknown> = {};
  const changed: Record<string, { from: unknown; to: unknown }> = {};

  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);

  for (const key of allKeys) {
    const inOld = key in a;
    const inNew = key in b;

    if (inOld && !inNew) {
      removed[key] = a[key];
    } else if (!inOld && inNew) {
      added[key] = b[key];
    } else if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      changed[key] = { from: a[key], to: b[key] };
    }
  }

  return {
    unchanged:
      Object.keys(added).length === 0 &&
      Object.keys(removed).length === 0 &&
      Object.keys(changed).length === 0,
    added,
    removed,
    changed,
  };
}

/**
 * Merges two or more filters into a single filter whose match set is the union
 * of all inputs — a record is included if it would match ANY of the inputs.
 *
 * @example
 * filterUnion({ color: "blue" }, { color: "red" })
 * // → { $or: [{ color: "blue" }, { color: "red" }] }
 */
export function filterUnion(
  ...filters: SubscriptionFilter[]
): SubscriptionFilter {
  if (filters.length === 0) return {};
  if (filters.length === 1) return simplifyFilter({ ...filters[0] });
  return simplifyFilter({ $or: filters });
}
