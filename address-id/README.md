# @mailwoman/address-id

**Stable, parseable address primary keys** — the deterministic, exact-match
complement to the fuzzy matcher.

Where `@mailwoman/match` decides whether two messy records are _probably_ the
same entity, `@mailwoman/address-id` produces a content-addressed key you can
`GROUP BY` or `JOIN ON` without running the matcher at all — for the common
"same canonical address" case.

```ts
import { createPostalAddressID } from "@mailwoman/address-id"

const id = createPostalAddressID({
	components: { street: "123 Main St", locality: "Austin", region: "TX", postcode: "78701" },
	coordinate: { lat: 30.2672, lon: -97.7431 },
})
// → "tx.882830829dfffff.abc123def456"
```

## Key structure

```
<state>.<H3-cell>.<content-hash>
```

| Segment          | Purpose                                                                                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **State prefix** | Coarse region (`tx`, `ca`, `ny`, …) from a supplied state or plucked from the ZIP via `@mailwoman/codex`; `xx` when unknown. Makes the key region-sortable.                                     |
| **H3 cell**      | Jitter-stable locality token from the resolved coordinate (`h3-js` `latLngToCell` at resolution 9). Coarse on purpose: two geocodes of the same place a few metres apart land in the same cell. |
| **Content hash** | Hash of the address canonicalized by `@mailwoman/normalize`, so `123 Main St` and `123 MAIN STREET` hash identically. This is the identity; the cell + state localize and partition it.         |

## API

```ts
// Create a stable address primary key
createPostalAddressID(input: PostalAddressIDInput): string

// Parse a key back into its components
parsePostalAddressID(id: string): ParsedPostalAddressID
// → { state: "tx", h3Cell: "882830829dfffff", hash: "abc123def456" }
```

## Design

- **Self-contained** on `h3-js`, not `@mailwoman/spatial` (which wasn't
  published when `address-id` shipped). Small, focused dependency footprint.
- **Content-addressed, not assigned.** The key derives from the data itself
  — no central registry, no sequence numbers.
- **Jitter-stable.** The H3 cell at resolution 9 (~0.03 km²) absorbs the
  small coordinate differences that come from geocoding the same address
  on different passes.

## Use cases

- **Deduplication** — `GROUP BY address_id` collapses records at the same
  canonical address without running the fuzzy matcher.
- **Cross-dataset joins** — deterministic exact-match join key for linking
  records across data sources.
- **Indexing** — ordered by state prefix for efficient range scans.

## Related

- [`@mailwoman/match`](../match) — the fuzzy matcher (complementary, not competing)
- [`@mailwoman/normalize`](../normalize) — canonicalization used by the content hash
- [`@mailwoman/codex`](../codex) — ZIP → state prefix resolution
- [`@mailwoman/formatter`](../formatter) — `canonicalKey` (also deterministic, used for blocking)

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html)
