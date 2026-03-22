type Selector = Record<string, unknown>;

// ---------------------------------------------------------------------------
// flatten — associative-law structural reductions
// ---------------------------------------------------------------------------

function reduceAnd($and: Selector[], selector: Selector): Selector {
  if ($and.length === 0) {
    return { ...selector, $and };
  }

  $and = $and
    .flatMap((s) => {
      const { $and: inner, ...rest } = s;
      const parts: Selector[] = [rest];
      if (Array.isArray(inner)) {
        if (inner.length === 0) parts.push({ $and: inner });
        else parts.push(...(inner as Selector[]));
      }
      return parts;
    })
    .filter((s) => Object.keys(s).length > 0);

  if ($and.length === 1 && Object.keys(selector).length === 0) return $and[0]!;
  if ($and.length > 0) return { ...selector, $and };
  return selector;
}

function reduceOr($or: Selector[], selector: Selector): Selector {
  if ($or.length === 0) return { ...selector, $or };

  $or = $or.flatMap((s) => {
    const { $or: inner, ...rest } = s;
    if (Object.keys(rest).length > 0) {
      return [inner !== undefined ? { ...rest, $or: inner } : rest];
    }
    if (inner !== undefined) {
      return (inner as Selector[]).length > 0
        ? (inner as Selector[])
        : [{ $or: inner }];
    }
    return [{}];
  });

  if ($or.length === 1 && Object.keys(selector).length === 0) return $or[0]!;
  if ($or.length > 0) return { ...selector, $or };
  return selector;
}

function reduceNor($nor: Selector[], selector: Selector): Selector {
  $nor = $nor.flatMap((s) => {
    const { $nor: inner, ...rest } = s;
    if (Object.keys(rest).length > 0) {
      return [inner !== undefined ? { ...rest, $nor: inner } : rest];
    }
    if (inner !== undefined) {
      return (inner as Selector[]).length > 0
        ? (inner as Selector[])
        : [{ $nor: inner }];
    }
    return [{}];
  });
  return { ...selector, $nor };
}

function flatten(s: Selector): Selector {
  const { $and, $or, $nor, ...rest } = s;
  let result: Selector = rest;
  if ($and !== undefined) result = reduceAnd((($and as Selector[]).map(flatten)), result);
  if ($or !== undefined)  result = reduceOr((($or  as Selector[]).map(flatten)), result);
  if ($nor !== undefined) result = reduceNor((($nor as Selector[]).map(flatten)), result);
  return result;
}

// ---------------------------------------------------------------------------
// parse-selector — selector → flat op list
// ---------------------------------------------------------------------------

interface Op { field: string; op: string; value: unknown }

function parseSelector(selector: Selector): Op[] {
  return Object.entries(selector).flatMap(([field, value]) => {
    if (field[0] === "$") {
      throw new Error(`Complex selectors with a ${field} clause cannot be parsed.`);
    }
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !Object.keys(value as object).some((k) => k[0] === "$")
    ) {
      return [{ field, op: "$eq", value }];
    }
    const v = value as Record<string, unknown>;
    if (Object.keys(v).every((k) => k[0] === "$")) {
      return Object.entries(v).map(([op, val]) => ({ field, op, value: val }));
    }
    throw new Error("Cannot mix $-operators with field values in sub-selector");
  });
}

// ---------------------------------------------------------------------------
// reduce-ops — merge/deduplicate ops per field
// ---------------------------------------------------------------------------

function valueIsEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => valueIsEqual(v, b[i]));
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const ka = Object.keys(a as object), kb = Object.keys(b as object);
    return ka.length === kb.length &&
      ka.every((k) => valueIsEqual((a as Record<string,unknown>)[k], (b as Record<string,unknown>)[k]));
  }
  return a === b;
}

function deduplicateArray<T>(arr: T[]): T[] {
  const seen: T[] = [];
  return arr.filter((v) => {
    if (seen.some((s) => valueIsEqual(s, v))) return false;
    seen.push(v);
    return true;
  });
}

function intersectArrays(...arrays: unknown[][]): unknown[] {
  let [a, ...rest] = arrays;
  for (const b of rest) {
    a = deduplicateArray([
      ...a!.filter((x) => b.some((y) => valueIsEqual(x, y))),
      ...b.filter((y) => a!.some((x) => valueIsEqual(x, y))),
    ]);
  }
  return a!;
}

type MergeFn = (values: unknown[]) => Selector[];

function mergeComparators(op: string, values: unknown[], pick: (nums: number[]) => number): Selector[] {
  const dates: Date[] = [], numbers: number[] = [], others: unknown[] = [];
  for (const v of values) {
    if (v instanceof Date) dates.push(v);
    else if (typeof v === "number") numbers.push(v);
    else others.push(v);
  }
  const result: Selector[] = others.map((v) => ({ [op]: v }));
  if (dates.length) result.push({ [op]: new Date(pick(dates.map((d) => d.getTime()))) });
  if (numbers.length) result.push({ [op]: pick(numbers) });
  return result;
}

const mergeValues: Record<string, MergeFn> = {
  $eq:  (vs) => [{ $in: vs.length > 1 ? [] : vs }],
  $ne:  (vs) => [{ $nin: vs }],
  $gt:  (vs) => mergeComparators("$gt",  vs, (ns) => Math.max(...ns)),
  $gte: (vs) => mergeComparators("$gte", vs, (ns) => Math.max(...ns)),
  $lt:  (vs) => mergeComparators("$lt",  vs, (ns) => Math.min(...ns)),
  $lte: (vs) => mergeComparators("$lte", vs, (ns) => Math.min(...ns)),
  $in:  (vs) => [{ $in: intersectArrays(...(vs as unknown[][])) }],
  $nin: (vs) => [{ $nin: deduplicateArray((vs as unknown[][]).flat()) }],
};

function reduceFieldOps(field: string, ops: Op[]): Op[] {
  let reducible = ops.filter((o) => mergeValues[o.op]);
  const irreducible = ops.filter((o) => !mergeValues[o.op]);

  for (let i = 0; i < 2; i++) {
    const selectors: Selector[] = Object.entries(mergeValues).flatMap(([opName, merge]) => {
      const vals = deduplicateArray(
        reducible.filter((o) => o.op === opName).map((o) => o.value)
      );
      return vals.length > 0 ? merge(vals).map((s) => ({ [field]: s })) : [];
    });
    reducible = selectors.flatMap((s) => parseSelector(s));
  }

  return [...reducible, ...irreducible].map((o) => ({ ...o, field }));
}

function reduceOps(ops: Op[]): Op[] {
  const fieldMap = new Map<string, Op[]>();
  for (const { field, ...op } of ops) {
    if (!fieldMap.has(field)) fieldMap.set(field, []);
    fieldMap.get(field)!.push({ field, ...op });
  }
  return [...fieldMap.entries()].flatMap(([field, ops]) => reduceFieldOps(field, ops));
}

// ---------------------------------------------------------------------------
// compile-selector — op list → selector
// ---------------------------------------------------------------------------

function simplifyValue(data: Record<string, unknown>): unknown {
  let { $in, $eq, $ne, $nin, ...rest } = data;
  const hasEq = Object.prototype.hasOwnProperty.call(data, "$eq");
  const hasNe = Object.prototype.hasOwnProperty.call(data, "$ne");

  let resolvedEq = $eq, resolvedEqSet = hasEq;
  let resolvedNe = $ne, resolvedNeSet = hasNe;

  if (!resolvedEqSet && Array.isArray($in) && ($in as unknown[]).length === 1) {
    resolvedEq = ($in as unknown[])[0]; resolvedEqSet = true;
  } else if ($in !== undefined) {
    rest = { ...rest, $in };
  }

  if (!resolvedNeSet && Array.isArray($nin) && ($nin as unknown[]).length === 1) {
    resolvedNe = ($nin as unknown[])[0]; resolvedNeSet = true;
  } else if ($nin !== undefined) {
    rest = { ...rest, $nin };
  }

  if (resolvedEqSet) {
    if (!resolvedNeSet && Object.keys(rest).length > 0) return { ...rest, $eq: resolvedEq };
    return resolvedEq;
  }
  if (resolvedNeSet) return { ...rest, $ne: resolvedNe };
  return rest;
}

function compileSelector(ops: Op[]): Selector {
  let selector: Record<string, Record<string, unknown>> = {};
  const $and: typeof selector[] = [selector];

  for (const { field, op, value } of ops) {
    if (!selector[field]) selector[field] = {};
    if (op in selector[field]!) {
      selector = { [field]: { [op]: value } };
      $and.push(selector);
    } else {
      selector[field]![op] = value;
    }
  }

  return flatten({
    $and: $and.map((s) =>
      Object.fromEntries(
        Object.entries(s).map(([field, val]) => [field, simplifyValue(val)])
      )
    ),
  });
}

// ---------------------------------------------------------------------------
// factorize — distributive law
// ---------------------------------------------------------------------------

export function factorize(input: Selector): Selector {
  let { $and, ...selector } = input;
  let andArr: Selector[] = Array.isArray($and) ? ($and as Selector[]) : [];

  if (Array.isArray($and) && ($and as Selector[]).length === 0) {
    andArr = [{ $and: [] }];
  }

  if (Object.keys(selector).length > 0) andArr = [...andArr, selector];

  const orClauses: Selector[][] = [];
  andArr = andArr
    .map((s) => {
      const { $or, ...rest } = s;
      if ($or !== undefined) orClauses.push($or as Selector[]);
      return rest;
    })
    .filter((s) => Object.keys(s).length > 0);

  const base: Selector = andArr.length > 0 ? { $and: andArr } : {};

  return flatten(
    orClauses.reduce<Selector>(
      (acc, $or) =>
        flatten({
          $or: $or
            .map((s) => ({ $and: [acc, s] }))
            .map(factorize),
        }),
      base
    )
  );
}

// ---------------------------------------------------------------------------
// simplify — main export
// ---------------------------------------------------------------------------

export function simplify(selector: Selector): Selector {
  const { $or, $and, $nor, ...more } = factorize(flatten(selector));

  // Build the list of selectors to parse: the $and branches plus any remaining
  // top-level fields. When $and is an empty array it carries semantic meaning
  // (MongoDB treats { $and: [] } as an error marker), so we wrap it.
  const andBranches: Selector[] = Array.isArray($and)
    ? ($and as Selector[]).length === 0
      ? [{ $and: [] }]
      : ($and as Selector[])
    : [];

  const ops = [...andBranches, { ...more }].flatMap((s) => parseSelector(s));

  // Preserve the empty-$and sentinel if present; otherwise start fresh.
  const compiledAnd: Selector[] =
    Array.isArray($and) && ($and as Selector[]).length === 0
      ? [{ $and: [] }, { ...compileSelector(reduceOps(ops)) }]
      : [{ ...compileSelector(reduceOps(ops)) }];

  let result: Selector = { $and: compiledAnd };
  if ($or)  result = { ...result, $or:  ($or  as Selector[]).map(simplify) };
  if ($nor) result = { ...result, $nor: ($nor as Selector[]).map(simplify) };

  return flatten(result);
}
