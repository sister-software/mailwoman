# `conventions.db` — the Geographic Rule Engine convention asset

A self-contained, read-only SQLite asset mapping **WOF polygon id → resolution convention**, consumed
by the Geographic Rule Engine (Direction E, [epic #288](https://github.com/sister-software/mailwoman/issues/288)).
A convention is a declarative profile — which strategies the resolver dispatches, in what order, with
what scoring weights — deep-merged up a resolved place's ancestor chain (country → region → locality,
most-specific wins). See [`docs/articles/plan/2026-06-05-geographic-rule-engine.md`](../docs/articles/plan/2026-06-05-geographic-rule-engine.md).

It's built like our other WOF tables: **from source, never a prebuilt dump**, and frozen into a
distributable artifact (a `meta` provenance row, `journal_mode=DELETE` so there's no `-wal`/`-shm`
sidecar, `ANALYZE`, an integrity check, and `VACUUM`).

## Why an asset and not a code constant

The convention store is queried **on demand** — one indexed lookup per WOF id, memoized — rather than
paged into runtime memory as a growing dictionary. That's deliberate: it's the counter to the pattern
where a geocoder accretes giant in-memory dictionaries with no provenance, then blacklists of poison
entries to protect the 99% case (trivia that reads as maturity and is really the
architecture conceding it can't generalize). Two rules fall out of that and are enforced here:

- **Every row carries `source` provenance** — where it came from / why it exists. (We don't store a
  literal "weight"; the point is that what each entry is responsible for stays _visible_ and
  accountable, not that there's a numeric column.)
- **A convention that names a strategy this build doesn't register is rejected at BUILD time, loudly**
  (and, defensively, surfaced as a one-time `console.warn` at dispatch rather than silently skipped).
- A convention that starts needing a **blacklist of poison entries** is a signal to fix the strategy
  or the model, not to grow the list.

## Schema

```sql
address_convention(
  wof_id     INTEGER PRIMARY KEY,  -- the WOF admin polygon this profile attaches to
  convention TEXT NOT NULL,        -- the Convention JSON (candidateStrategies, scoringWeights, …)
  source     TEXT NOT NULL         -- provenance: why this row exists / where it came from
)
meta(key TEXT, value TEXT)         -- name/description/schema_version/source/rows/strategies_known
```

The resolver attaches the asset as a shard and auto-detects it (the same mechanism as the
`postcode_locality` table — adding `conventions.db` to `databasePath` enables it). Conventions can also
be injected directly via `new WofSqlitePlaceLookup({ conventions })` (a ready `ConventionSource` or a
`{ wofId: Convention }` seed map) for tests and embedding.

## Authoring + build

The human-editable source of truth is **`data/conventions/conventions.json`** — a JSON array of
authored entries. The `.db` is the compiled, queryable form.

```jsonc
// data/conventions/conventions.json
[
	{
		"wof_id": 85633111, // e.g. a country / region / locality WOF id
		"source": "JP country profile — block-coordinate addressing (chōme/banchi/gō)",
		"convention": {
			"candidateStrategies": ["postcode_area_resolution", "fallback_fuzzy_name_match"],
			"scoringWeights": { "pc": 0.7 }, // partial — unspecified weights inherit WORLD_DEFAULT
		},
	},
]
```

```bash
# build from source (validates strategy names; rejects unknown ones loudly)
node scripts/build-conventions.ts \
  --src data/conventions/conventions.json \
  --output /mnt/playpen/mailwoman-data/wof/conventions.db
```

`scripts/build-conventions.ts` validates each entry (numeric unique `wof_id`, non-empty `source`,
known strategy names, known `scoringWeights` keys) before writing — a typo'd strategy fails the build,
not a production query.

## Status

The authored source ships **empty**: the EU locales (DE/FR/GB/NL) ride `WORLD_DEFAULT`, so they need no
rows, and adding no-op rows that merely restate the default would be exactly the trivia we avoid. The
first real rows land with JP/KR/TW coarse resolution ([#292](https://github.com/sister-software/mailwoman/issues/292)
/ [#293](https://github.com/sister-software/mailwoman/issues/293) /
[#294](https://github.com/sister-software/mailwoman/issues/294)). The schema, build, runtime source,
and wiring are in place and tested; the asset is built and shipped once it has rows.

## Caveats / follow-ups

- **Conventions are code-coupled.** A convention references strategy _names_; the strategy
  _implementations_ live in `lookup.ts`. An asset built against a newer code revision (one that adds a
  strategy) names a strategy an older build won't have — that's why the runtime warns-and-skips rather
  than throwing, and why the `meta.strategies_known` row records what the asset was built against.
- **`field_mapping` / `tokenNormalization` are not in the schema yet** — the #289/#290 slice ships
  `candidateStrategies` + `scoringWeights`; later phases (the `locator[]` semantics) extend the
  `Convention` JSON, no schema migration needed (it's an opaque JSON column).
