# @sync-subscribe/mongo-selector-simplifier

Simplifies and normalises MongoDB-style query selectors. Used internally by `@sync-subscribe/core` to canonicalise subscription filters before comparison and filter-matching.

## Installation

```bash
npm install @sync-subscribe/mongo-selector-simplifier
```

## Usage

```ts
import { simplifySelector } from "@sync-subscribe/mongo-selector-simplifier";

// Collapses redundant $and/$or nesting, normalises shorthand equality, etc.
const simplified = simplifySelector({
  $and: [{ color: "blue" }, { isDeleted: false }],
});
// → { color: "blue", isDeleted: false }
```

This package is a low-level utility. For application code, use the filter types from `@sync-subscribe/core` and the matching function `matchesFilter`.
