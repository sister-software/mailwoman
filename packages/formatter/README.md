# @mailwoman/formatter

**The inverse of the parser** — render Mailwoman address components into an
idiomatic, per-country address string, plus produce a canonical, normalized
match key for record linkage.

```ts
import { formatAddress, formatAddressRow, canonicalKey } from "@mailwoman/formatter"

const components = {
	house_number: "1600",
	street: "Amphitheatre Parkway",
	locality: "Mountain View",
	region: "CA",
	postcode: "94043",
}

// Envelope form
formatAddress(components, "US")
// → "1600 Amphitheatre Parkway\nMountain View, CA 94043"

// The single line a query or a corpus row takes, joined the way the country does
formatAddress(components, "US", { singleLine: true })
// → "1600 Amphitheatre Parkway, Mountain View, CA 94043"

// Canonical match key (for blocking / dedup)
canonicalKey(components)
// → "1600 amphitheatre pkwy mountain view ca 94043"
```

## API

```ts
// components → idiomatic display string; "" when the dict is empty or no layout names the country
formatAddress(components: ComponentDict, country: string, opts?: FormatAddressOptions): string

// the render AND what it printed, in one pass; null when nothing rendered
formatAddressRow(
	components: ComponentDict,
	country: string,
	opts?: FormatAddressOptions
): { raw: string; components: ComponentDict; unplaced: readonly ComponentTag[] } | null

// which components occur verbatim in a string somebody ELSE built
componentsPresentIn(components: ComponentDict, raw: string): ComponentDict

// the legacy rule-classifier vocabulary, through the same layouts
formatFromClassificationMap(map: ClassificationMap, country: string, opts?: FormatAddressOptions): string

// canonical match key — normalized, deterministic string for record linkage
canonicalKey(components: ComponentDict): string
```

`FormatAddressOptions` carries `separator` (default `"\n"`, the envelope form)
and `singleLine`, which joins the lines the way the country does — `", "` for
most, `" "` for Japan and Korea, nothing at all for the Chinese-script systems,
whose admin run is unseparated.

## What it does

| Function               | Purpose                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`formatAddress`**    | Render components through the country's layout in `@mailwoman/codex/address-layouts`.                                                                                                                               |
| **`formatAddressRow`** | The same render, plus the tags it PLACED and the ones it could not — what an adapter aligning labels against a string needs, without paying for a second render or searching the output for each value.             |
| **`canonicalKey`**     | Produce a lowercase, abbreviation-expanded, punctuation-stripped key that two records for the same place will match on, even if their original strings differ (`"123 Main St"` and `"123 MAIN STREET"` → same key). |

## Design

- **The order is data, and this package owns it.** Each country's print order
  lives in `@mailwoman/codex` as a tagged template that reads in the order it
  prints; this package is the evaluator. There are no third-party runtime
  dependencies.
- **One rule governs rendering.** A node that renders nothing removes itself,
  and its connector goes with it. A connector between two slots needs a rendered
  slot on each side; a connector at a line's edge binds to the one slot it
  touches. That single rule replaces a per-country table of which slots a
  template could reach, a pass that stripped connectors around empty values, and
  a pass that spliced missing lines back in.
- **An absence is reported, not invented.** 55 of the 252 shipped country
  records carry no usable skeleton, and `formatAddress` answers `""` for one of
  those rather than guessing an order. A value the layout has no slot for is
  named in `unplaced`.
- **Match key is deterministic.** No machine learning, no scoring — the
  canonical key is a pure function of the address components. It's the
  exact-match complement to the fuzzy matcher's probabilistic scoring.

## Related

- [`@mailwoman/codex`](../codex) — the per-country layout table and the `ComponentTag` union
- [`@mailwoman/match`](../match) — the fuzzy matcher (uses canonical key for blocking)
- [`@mailwoman/record`](../record) — record normalizers that call into formatter
- [`@mailwoman/address-id`](../address-id) — stable primary key (complementary to canonical key)

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html)
