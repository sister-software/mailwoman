# @mailwoman/address-id

This package produces stable, parseable primary keys for addresses. It is the
deterministic, exact-match complement to the fuzzy matcher.

`@mailwoman/match` decides whether two messy records are _probably_ the same
entity. `@mailwoman/address-id` produces a content-addressed key that you can
`GROUP BY` or `JOIN ON` without running the matcher. The key covers the common
case where two records share the same canonical address.

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

| Segment          | Purpose                                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **State prefix** | Coarse region (`tx`, `ca`, `ny`, …) from a supplied state or from the ZIP via `@mailwoman/codex`. It is `xx` when the state is unknown. The prefix makes the key sortable by region.                    |
| **H3 cell**      | Jitter-stable locality token from the resolved coordinate (`h3-js` `latLngToCell` at resolution 9). The cell is coarse so that two geocodes of the same place a few meters apart land in the same cell. |
| **Content hash** | Hash of the address canonicalized by `@mailwoman/normalize`, so `123 Main St` and `123 MAIN STREET` hash identically. The hash carries the identity. The cell and state localize and partition it.      |

## API

```ts
// Create a stable address primary key
createPostalAddressID(input: PostalAddressIDInput): string

// Parse a key back into its components
parsePostalAddressID(id: string): ParsedPostalAddressID
// → { state: "tx", h3Cell: "882830829dfffff", hash: "abc123def456" }
```

## Design

- **Self-contained.** The package depends on `h3-js` rather than
  `@mailwoman/spatial`, which was not published when `address-id` shipped. The
  dependency footprint stays small.
- **Content-addressed rather than assigned.** The key derives from the data
  itself, so the package needs neither a central registry nor sequence numbers.
- **Jitter-stable.** The H3 cell at resolution 9 (~0.03 km²) absorbs the
  small coordinate differences that come from geocoding the same address
  on different passes.

## Use cases

- **Deduplication.** `GROUP BY address_id` collapses records at the same
  canonical address without running the fuzzy matcher.
- **Cross-dataset joins.** The key is a deterministic exact-match join key for
  linking records across data sources.
- **Indexing.** Keys sort by state prefix, which supports efficient range scans.

## Related

- [`@mailwoman/match`](../match): the fuzzy matcher, which complements this package.
- [`@mailwoman/normalize`](../normalize): the canonicalization used by the content hash.
- [`@mailwoman/codex`](../codex): ZIP → state prefix resolution.
- [`@mailwoman/formatter`](../formatter): `canonicalKey`, which is also deterministic and is used for blocking.

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/AGPL-3.0.html)
