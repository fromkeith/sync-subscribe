import { describe, expect, it } from "vitest";
import {
  isAlwaysFalse,
  negateFilter,
  filterUnion,
  simplifyFilter,
  matchesFilter,
} from "../filterMatcher.js";
import type { SubscriptionFilter } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers that mirror the gap computation in SyncClient.subscribe().
// rawGap does NOT call simplifyFilter before isAlwaysFalse — the simplifier
// can destroy contradictions (e.g. collapses {$and:[{x:1},{x:{$ne:1}}]}→{x:1}).
// simplifyFilter is only called by negateFilter on its own output, and by
// gapFilter() when preparing the actual filter for the server.
// ---------------------------------------------------------------------------
function rawGap(
  fNew: SubscriptionFilter,
  existingFilters: SubscriptionFilter[],
): SubscriptionFilter {
  return {
    $and: [fNew, negateFilter(filterUnion(...existingFilters))],
  } as SubscriptionFilter;
}

function hasGap(
  fNew: SubscriptionFilter,
  existingFilters: SubscriptionFilter[],
): boolean {
  return !isAlwaysFalse(rawGap(fNew, existingFilters));
}

/**
 * Returns the mathematically correct gap filter for use with matchesFilter.
 * We use the raw (un-simplified) form because simplifyFilter can drop conditions
 * from complex compound filters, producing an unsound result.
 * For the "does not throw" tests we use simplifyFilter separately.
 */
function gapFilter(
  fNew: SubscriptionFilter,
  existingFilters: SubscriptionFilter[],
): SubscriptionFilter {
  return rawGap(fNew, existingFilters);
}

// ---------------------------------------------------------------------------
// isAlwaysFalse — unit tests
// ---------------------------------------------------------------------------
describe("isAlwaysFalse", () => {
  describe("returns false for satisfiable filters", () => {
    it("empty filter matches everything", () => {
      expect(isAlwaysFalse({})).toBe(false);
    });

    it("equality filter", () => {
      expect(isAlwaysFalse({ color: "blue" })).toBe(false);
    });

    it("$ne filter", () => {
      expect(isAlwaysFalse({ color: { $ne: "blue" } })).toBe(false);
    });

    it("$in with values", () => {
      expect(isAlwaysFalse({ status: { $in: ["open", "closed"] } })).toBe(false);
    });

    it("$gt range", () => {
      expect(isAlwaysFalse({ priority: { $gt: 0 } })).toBe(false);
    });

    it("$or with satisfiable branches", () => {
      expect(
        isAlwaysFalse({ $or: [{ color: "blue" }, { color: "red" }] }),
      ).toBe(false);
    });

    it("$and with satisfiable branches", () => {
      expect(
        isAlwaysFalse({ $and: [{ userId: "u1" }, { color: "blue" }] }),
      ).toBe(false);
    });

    it("$or with one always-false and one valid branch", () => {
      expect(
        isAlwaysFalse({ $or: [{ $or: [] }, { color: "blue" }] }),
      ).toBe(false);
    });
  });

  describe("returns true for unsatisfiable filters", () => {
    it("$or: [] — OR of nothing", () => {
      expect(isAlwaysFalse({ $or: [] })).toBe(true);
    });

    it("field $in: [] — empty membership set", () => {
      expect(isAlwaysFalse({ status: { $in: [] } })).toBe(true);
    });

    it("$and containing always-false child", () => {
      expect(isAlwaysFalse({ $and: [{ status: { $in: [] } }] })).toBe(true);
    });

    it("$or where every branch is always-false", () => {
      expect(
        isAlwaysFalse({ $or: [{ status: { $in: [] } }, { $or: [] }] }),
      ).toBe(true);
    });

    it("negateFilter({}) — negation of match-all = never", () => {
      // negateFilter({}) produces { $nor: [{}] }
      expect(isAlwaysFalse(negateFilter({}))).toBe(true);
    });
  });

  describe("contradictory conditions in $and branches", () => {
    // NOTE: these tests pass the raw filter directly to isAlwaysFalse.
    // simplifyFilter must NOT be called first — it can destroy contradictions
    // (e.g. collapses { $and: [{x:1},{x:{$ne:1}}] } to {x:1}).

    it("equality + $ne on same field", () => {
      expect(
        isAlwaysFalse({ $and: [{ color: "blue" }, { color: { $ne: "blue" } }] }),
      ).toBe(true);
    });

    it("two different equality values for the same field", () => {
      expect(
        isAlwaysFalse({ $and: [{ color: "blue" }, { color: "red" }] }),
      ).toBe(true);
    });

    it("$in and $nin with identical sets on same field (merged object)", () => {
      // This form is what the simplifier may produce after merging $and branches
      expect(
        isAlwaysFalse({ status: { $in: ["open", "closed"], $nin: ["open", "closed"] } }),
      ).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Gap analysis — no gap expected
// These assert that F_new ⊆ union(existingFilters) is correctly detected.
// ---------------------------------------------------------------------------
describe("gap analysis — no gap", () => {
  it("exact same filter", () => {
    expect(hasGap({ color: "blue" }, [{ color: "blue" }])).toBe(false);
  });

  it("F_new is a subset: adds extra constraint beyond the existing sub", () => {
    // existing covers all u1 records; new adds color constraint → subset
    expect(
      hasGap({ userId: "u1", color: "blue" }, [{ userId: "u1" }]),
    ).toBe(false);
  });

  it("F_new is a subset via $in narrowing", () => {
    // existing covers all open+closed; new only wants open → subset
    expect(
      hasGap(
        { status: { $in: ["open"] } },
        [{ status: { $in: ["open", "closed"] } }],
      ),
    ).toBe(false);
  });

  it("catch-all existing subscription covers any F_new", () => {
    // {} matches every record — nothing can be outside it
    expect(hasGap({ color: "blue", userId: "u1" }, [{}])).toBe(false);
  });

  it("catch-all existing subscription covers range F_new", () => {
    expect(hasGap({ priority: { $gt: 5 } }, [{}])).toBe(false);
  });

  it("two existing subs together cover F_new via $in split", () => {
    // new wants open|closed; one sub covers open, another covers closed
    expect(
      hasGap(
        { status: { $in: ["open", "closed"] } },
        [{ status: "open" }, { status: "closed" }],
      ),
    ).toBe(false);
  });

  it("three existing subs together cover a three-value $in", () => {
    expect(
      hasGap(
        { status: { $in: ["open", "pending", "closed"] } },
        [{ status: "open" }, { status: "pending" }, { status: "closed" }],
      ),
    ).toBe(false);
  });

  it("F_new with multiple fields covered by narrower existing sub", () => {
    // Existing covers u1+blue; new is the same combination
    expect(
      hasGap({ userId: "u1", color: "blue" }, [{ userId: "u1", color: "blue" }]),
    ).toBe(false);
  });

  it("numeric range: F_new is subset of existing range", () => {
    // existing: priority ≥ 1; new: priority ≥ 1 AND ≤ 10
    expect(
      hasGap(
        { priority: { $gte: 1, $lte: 10 } },
        [{ priority: { $gte: 1 } }],
      ),
    ).toBe(false);
  });

  it("F_new with $ne covered by existing same-field $ne", () => {
    expect(
      hasGap({ status: { $ne: "deleted" } }, [{ status: { $ne: "deleted" } }]),
    ).toBe(false);
  });

  it("multiple fields: each covered by dedicated sub plus catch-all userId", () => {
    // existing is all records for userId u1; new adds isDeleted:false
    expect(
      hasGap({ userId: "u1", isDeleted: false }, [{ userId: "u1" }]),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gap analysis — gap expected
// These assert that F_new ⊄ union(existingFilters) is correctly detected.
// ---------------------------------------------------------------------------
describe("gap analysis — gap exists", () => {
  it("F_new is a superset: less specific than existing sub", () => {
    // existing only covers blue; new covers all userId u1 records
    expect(
      hasGap({ userId: "u1" }, [{ userId: "u1", color: "blue" }]),
    ).toBe(true);
  });

  it("completely disjoint filters", () => {
    expect(hasGap({ color: "red" }, [{ color: "blue" }])).toBe(true);
  });

  it("partial $in overlap — existing covers subset of new values", () => {
    // new wants open|closed|pending; existing only covers open
    expect(
      hasGap(
        { status: { $in: ["open", "closed", "pending"] } },
        [{ status: "open" }],
      ),
    ).toBe(true);
  });

  it("two subs cover only part of a three-value $in", () => {
    expect(
      hasGap(
        { status: { $in: ["open", "closed", "pending"] } },
        [{ status: "open" }, { status: "closed" }],
      ),
    ).toBe(true);
  });

  it("F_new has no userId constraint; existing is scoped to one user", () => {
    expect(hasGap({ color: "blue" }, [{ userId: "u1", color: "blue" }])).toBe(true);
  });

  it("F_new uses $ne but existing uses equality (different semantic scope)", () => {
    // existing: only blue; new: everything except blue
    expect(
      hasGap({ color: { $ne: "blue" } }, [{ color: "blue" }]),
    ).toBe(true);
  });

  it("completely different field", () => {
    // existing filters on color; new filters on userId — orthogonal sets
    expect(hasGap({ userId: "u1" }, [{ color: "blue" }])).toBe(true);
  });

  it("multiple existing subs but still a gap on unrelated field", () => {
    // existing covers open and closed, but only for user u1
    expect(
      hasGap(
        { status: { $in: ["open", "closed"] } },
        [
          { userId: "u1", status: "open" },
          { userId: "u1", status: "closed" },
        ],
      ),
    ).toBe(true);
  });

  it("single existing sub with extra constraint leaves unconstrained records", () => {
    // existing: isDeleted:false only; new: all records regardless of isDeleted
    expect(hasGap({}, [{ isDeleted: false }])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Complex multi-layer — no gap
// Three or more fields, nested $or in F_new, combinations of operator types.
// ---------------------------------------------------------------------------
describe("complex gap analysis — no gap", () => {
  it("three-field subset: F_new adds status constraint to a broader existing sub", () => {
    // existing covers all u1 + non-deleted; new additionally filters by status
    expect(
      hasGap(
        { userId: "u1", isDeleted: false, status: "open" },
        [{ userId: "u1", isDeleted: false }],
      ),
    ).toBe(false);
  });

  it("F_new with range constraint is subset of existing broader range", () => {
    // existing: priority ≥ 1 for u1; new: priority 1–10 for u1 (subset)
    expect(
      hasGap(
        { userId: "u1", priority: { $gte: 1, $lte: 10 } },
        [{ userId: "u1", priority: { $gte: 1 } }],
      ),
    ).toBe(false);
  });

  it("F_new scoped to a user + status combo, existing is the broader user scope", () => {
    // existing covers all records for u1; new is u1+open+high-priority (subset)
    expect(
      hasGap(
        { userId: "u1", status: "open", priority: { $gte: 5 } },
        [{ userId: "u1" }],
      ),
    ).toBe(false);
  });

  it("$or F_new is fully covered by a catch-all existing sub", () => {
    // {} catches everything; F_new's $or is a subset of everything
    expect(
      hasGap(
        { $or: [{ category: "work" }, { category: "personal" }] } as SubscriptionFilter,
        [{}],
      ),
    ).toBe(false);
  });

  it("$or F_new where each branch is individually covered by an existing sub", () => {
    // work covered by first sub, personal by second
    expect(
      hasGap(
        { $or: [{ userId: "u1", category: "work" }, { userId: "u1", category: "personal" }] } as SubscriptionFilter,
        [{ userId: "u1", category: "work" }, { userId: "u1", category: "personal" }],
      ),
    ).toBe(false);
  });

  it("multi-field $in F_new, union of two subs covers both fields together", () => {
    // existing: u1+open and u1+closed together cover u1+{open,closed}
    expect(
      hasGap(
        { userId: "u1", status: { $in: ["open", "closed"] } },
        [{ userId: "u1", status: "open" }, { userId: "u1", status: "closed" }],
      ),
    ).toBe(false);
  });

  it("F_new with $ne is covered by existing $ne on same field + value", () => {
    expect(
      hasGap(
        { userId: "u1", status: { $ne: "deleted" } },
        [{ userId: "u1", status: { $ne: "deleted" } }],
      ),
    ).toBe(false);
  });

  it("four-field F_new is subset of single two-field existing sub", () => {
    // existing: u1 + non-deleted; new: u1 + non-deleted + status + priority (all subsets)
    expect(
      hasGap(
        { userId: "u1", isDeleted: false, status: "open", priority: { $gte: 1 } },
        [{ userId: "u1", isDeleted: false }],
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Complex multi-layer — gap exists
// ---------------------------------------------------------------------------
describe("complex gap analysis — gap exists", () => {
  it("$or F_new partially covered — one branch outside existing", () => {
    // work is covered; personal is not
    expect(
      hasGap(
        { $or: [{ category: "work" }, { category: "personal" }] } as SubscriptionFilter,
        [{ category: "work" }],
      ),
    ).toBe(true);
  });

  it("multi-field F_new where only some status values are covered", () => {
    // existing: u1+open; new: u1+{open,closed,pending} → closed+pending are a gap
    expect(
      hasGap(
        { userId: "u1", status: { $in: ["open", "closed", "pending"] } },
        [{ userId: "u1", status: "open" }],
      ),
    ).toBe(true);
  });

  it("F_new is broader than existing by one field — existing is the subset", () => {
    // existing: u1+open+isDeleted:false (narrower); new: u1+open (broader)
    // Records where isDeleted:true are covered by fNew but not existing → gap
    expect(
      hasGap(
        { userId: "u1", status: "open" },
        [{ userId: "u1", status: "open", isDeleted: false }],
      ),
    ).toBe(true);
  });

  it("two existing subs that are field-scoped cannot cover a field-less F_new", () => {
    // Both subs require userId; F_new has no userId constraint → any other userId is a gap
    expect(
      hasGap(
        { status: "open" },
        [{ userId: "u1", status: "open" }, { userId: "u2", status: "open" }],
      ),
    ).toBe(true);
  });

  it("existing covers a higher-priority range; lower-priority records are a gap", () => {
    // existing: priority ≥ 5; new: all priorities → records 1–4 are a gap
    expect(
      hasGap(
        { userId: "u1" },
        [{ userId: "u1", priority: { $gte: 5 } }],
      ),
    ).toBe(true);
  });

  it("existing covers open for u1, but F_new is all statuses for u1+u2", () => {
    expect(
      hasGap(
        { status: { $in: ["open", "closed"] } },
        [{ userId: "u1", status: "open" }],
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gap filter simplification
// When a gap IS detected, verify that simplifyFilter(rawGap) produces a filter
// that (a) doesn't throw, and (b) correctly matches/excludes specific records.
// This validates the filter we actually send to the server for the gap sub.
// ---------------------------------------------------------------------------
describe("gap filter — simplified form matches correct records", () => {
  it("$in minus one existing equality: gap filter matches remaining values", () => {
    // F_new wants open|closed|pending; existing covers open.
    // Gap filter should match closed and pending, but not open.
    const f = gapFilter(
      { status: { $in: ["open", "closed", "pending"] } },
      [{ status: "open" }],
    );
    expect(matchesFilter({ status: "closed" }, f)).toBe(true);
    expect(matchesFilter({ status: "pending" }, f)).toBe(true);
    expect(matchesFilter({ status: "open" }, f)).toBe(false);
  });

  it("broader F_new vs scoped existing: gap filter excludes the covered subset", () => {
    // existing: u1+blue; new: all u1 records.
    // Gap filter should match u1+red but not u1+blue.
    const f = gapFilter(
      { userId: "u1" },
      [{ userId: "u1", color: "blue" }],
    );
    expect(matchesFilter({ userId: "u1", color: "red" }, f)).toBe(true);
    expect(matchesFilter({ userId: "u1", color: "blue" }, f)).toBe(false);
    expect(matchesFilter({ userId: "u2", color: "red" }, f)).toBe(false);
  });

  it("F_new vs user-scoped existing: gap filter matches other users", () => {
    // existing: u1; new: no constraint (all records).
    // Gap filter should match u2, u3, etc. but not u1.
    const f = gapFilter({}, [{ userId: "u1" }]);
    expect(matchesFilter({ userId: "u2", status: "open" }, f)).toBe(true);
    expect(matchesFilter({ userId: "u1", status: "open" }, f)).toBe(false);
  });

  it("multi-field gap: filter matches records outside the covered region", () => {
    // existing: u1+open; new: u1+{open,closed}.
    // Gap filter should match u1+closed but not u1+open.
    const f = gapFilter(
      { userId: "u1", status: { $in: ["open", "closed"] } },
      [{ userId: "u1", status: "open" }],
    );
    expect(matchesFilter({ userId: "u1", status: "closed" }, f)).toBe(true);
    expect(matchesFilter({ userId: "u1", status: "open" }, f)).toBe(false);
    expect(matchesFilter({ userId: "u2", status: "closed" }, f)).toBe(false);
  });

  it("simplifying the gap filter does not throw for complex multi-field negation", () => {
    // Regression: simplifyFilter must not throw for any filter produced by rawGap.
    expect(() =>
      simplifyFilter(rawGap(
        { userId: "u1", status: { $in: ["open", "closed", "pending"] }, isDeleted: false },
        [{ userId: "u1", status: "open", isDeleted: false }],
      )),
    ).not.toThrow();
  });

  it("simplifying the gap filter does not throw when negating a two-field union", () => {
    expect(() =>
      simplifyFilter(rawGap(
        { status: { $in: ["open", "closed", "pending"] } },
        [{ userId: "u1", status: "open" }, { userId: "u1", status: "closed" }],
      )),
    ).not.toThrow();
  });
});
