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

## Attribution

This package is a TypeScript port of [@candis/mongo-selector-simplifier](https://github.com/CandisIO/mongo-selector-simplifier) by [Candis](https://candis.io), used under the MIT License. See [LICENSE](./LICENSE) for details.
