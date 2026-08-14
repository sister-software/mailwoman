# @mailwoman/record

**Record schema and per-field normalizers** for the geocode-first entity
resolution matcher. Address-first design: the canonical `PostalAddress` record
composes parsed address components, the formatter's match key, and a resolved
geocode. Organization and contact records build on the same canonical record.

```ts
import { PostalAddress, parsePersonName, canonicalizeOrganizationName } from "@mailwoman/record";

// Canonical address record (parser output → canonical form)
const address: PostalAddress = {
  components: { house_number: "1600", street: "Amphitheatre Parkway", ... },
  canonicalKey: "1600 amphitheatre pkwy mountain view ca 94043",
  coordinate: { lat: 37.4224, lon: -122.0842 },
};

// Person name parsing
const name = parsePersonName("Jane L. Smith");
// → { given: "Jane", middleInitial: "L", surname: "Smith" }

// Organization name canonicalization (for dedup)
canonicalizeOrganizationName("Baylor University Medical Center");
// → "baylor university medical center"

canonicalizeOrganizationName("Baylor Univ. Med. Ctr.");
// → "baylor university medical center"  (same key)
```

## API

```ts
// Address record (the core of the record system)
import { PostalAddress, createPostalAddress } from "@mailwoman/record/address"

// Person name parsing → structured components
import { parsePersonName, type ParsedPersonName } from "@mailwoman/record/name"

// Organization name canonicalization → matchable key
import { canonicalizeOrganizationName, type CanonicalizeOrgOpts } from "@mailwoman/record/organization"
```

## What it normalizes

| Field            | Normalizer                     | Purpose                                                       |
| ---------------- | ------------------------------ | ------------------------------------------------------------- |
| **Address**      | `createPostalAddress`          | Parse components + formatter key + geocode → canonical record |
| **Person name**  | `parsePersonName`              | "Jane L. Smith" → `{given, middleInitial, surname}`           |
| **Organization** | `canonicalizeOrganizationName` | "Baylor Univ. Med. Ctr." → "baylor university medical center" |

## Design

- **Plain data, no classes.** Records are plain TypeScript objects with
  branded types where needed.
- **Address-first.** The `PostalAddress` is the canonical record — the geocode-first
  matcher resolves places, not strings.
- **Domain-scoped.** Organization canonicalization supports jurisdiction and
  domain context (e.g., `{jurisdiction: "ID"}` for Indonesian legal designations,
  `{domain: "healthcare"}` to protect PT/SCA from collision with medical
  abbreviations).
- **Lean dependencies.** Only depends on `@mailwoman/formatter` for the
  canonical key.

## Related

- [`@mailwoman/match`](../match) — the fuzzy matcher that consumes these records
- [`@mailwoman/formatter`](../formatter) — `canonicalKey` used by `PostalAddress`
- [`@mailwoman/registry`](../registry) — high-level `resolveEntities` that uses records
- [Geocode-First Record Matching](https://mailwoman.sister.software/articles/concepts/geocode-first-record-matching/)

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html)
