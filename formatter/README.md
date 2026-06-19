# @mailwoman/formatter

**The inverse of the parser** — render Mailwoman address components into an
idiomatic, locale-aware address string, plus produce a canonical, normalized
match key for record linkage.

```ts
import { formatAddress, canonicalKey } from "@mailwoman/formatter";

const components = {
  house_number: "1600",
  street: "Amphitheatre Parkway",
  locality: "Mountain View",
  region: "CA",
  postcode: "94043",
  country: "US",
};

// Display format
formatAddress(components, { locale: "en-US" });
// → "1600 Amphitheatre Parkway, Mountain View, CA 94043"

// Canonical match key (for blocking / dedup)
canonicalKey(components);
// → "1600 amphitheatre pkwy mountain view ca 94043"
```

## API

```ts
// Address formatting — components → idiomatic display string
formatAddress(
  components: ClassificationMap,
  opts?: { locale?: LocaleTag; country?: string }
): string

// Shortcut that takes a Classification directly
formatFromClassificationMap(
  classification: ClassificationMap,
  opts?: FormatOpts
): string

// Canonical match key — normalized, deterministic string for record linkage
canonicalKey(components: ClassificationMap): string
```

## What it does

| Function | Purpose |
|----------|---------|
| **`formatAddress`** | Render parsed components into a locale-appropriate address string using `@fragaria/address-formatter` templates. |
| **`canonicalKey`** | Produce a lowercase, abbreviation-expanded, punctuation-stripped key that two records for the same place will match on, even if their original strings differ (`"123 Main St"` and `"123 MAIN STREET"` → same key). |

## Design

- **Locale-aware formatting.** Uses `@fragaria/address-formatter`'s per-country
  templates, so `region postcode` renders `"CA 94043"` for US but `"75008 Paris"`
  for FR.
- **Match key is deterministic.** No machine learning, no scoring — the
  canonical key is a pure function of the address components. It's the
  exact-match complement to the fuzzy matcher's probabilistic scoring.
- **Consolidated API.** Formerly scattered across `@mailwoman/core` and the
  corpus synthesis layer; now one package, one API.

## Related

- [`@mailwoman/match`](../match) — the fuzzy matcher (uses canonical key for blocking)
- [`@mailwoman/record`](../record) — record normalizers that call into formatter
- [`@mailwoman/address-id`](../address-id) — stable primary key (complementary to canonical key)
- [`@mailwoman/core`](../core) — `ClassificationMap`, `ComponentTag` types

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html)
