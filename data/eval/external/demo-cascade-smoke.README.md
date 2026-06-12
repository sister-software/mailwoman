# Demo-cascade smoke rows (`demo-cascade-smoke.jsonl`)

The whole-stack smoke eval (#524). Every other gate lens is per-layer; this file
exists because three production bugs (#520 gazetteer-feeds crash, #521 reconcile
fragmentation subsidy, #522 resolver placetype exclusion) all shipped through
green per-layer gates on 2026-06-11. Nothing in the battery ran
parse → reconcile → resolve as ONE pass the way the demo (and any real consumer)
does — the operator's browser glance found all three in five minutes.

Runner: [`scripts/eval/demo-cascade-smoke.ts`](../../../scripts/eval/demo-cascade-smoke.ts)
(compose `runPipeline` + the demo's `runCascade` over the Node lookup against the
slim `wof-hot.db` the demo serves). Wired as an env-gated leg of
`scripts/eval/promotion-gate.sh` — it runs whenever the hot DB is present and
skips with a loud note when it isn't.

## The convention

- **Rows assert the RESOLVED WOF PLACE ID** — the top cascade hit's `id` — not
  parse components. A row passes only when the entire stack lands on the right
  place. (`expect.name` / `expect.placetype` are human-readable cross-checks,
  not graded.)
- **Whole-stack**: each `input` goes through the FULL pipeline — neural parse
  with the ship config (gazetteer lexicon, postcode anchor, conventions mask,
  span bridge, FST), joint reconcile, grouper audit, then the demo's cascade
  (postcode → locality-with-region-bbox → raw text) against the slim hot DB.
- **Additions welcome, but ids MUST be verified against the gazetteer** before a
  row is committed: query the staged `wof-hot.db` directly (e.g. via
  `WofSqlitePlaceLookup.findPlace`) and confirm the id, name, placetype, and
  rough coordinates identify the place you mean. Never pin an id by copying the
  runner's own output — that bakes the current behavior in as truth, which is
  exactly the failure mode this eval exists to catch.
- **Do not massage a failing row.** A FAIL here is a finding (it may be a real
  bug — that is the point). If the gazetteer itself changes (a WOF id genuinely
  supersedes another), update the row with a note explaining the re-verification.

## Row schema

One JSON object per line (blank lines and `#`/`//` comment lines are skipped):

```json
{
	"input": "Brooklyn",
	"expect": { "id": 421205765, "name": "Brooklyn", "placetype": "borough" },
	"note": "why this row exists / what failure mode it pins",
	"source": "#522"
}
```

- `input` (required): the raw query, verbatim as a user would type it.
- `expect` (required): exactly ONE of
  - `id` — positive-integer WOF id the top cascade hit must carry, or
  - `anchor_centroid: true` — the cascade must dead-end (no WOF row, e.g. a
    bare US ZIP on the slim DB, which ships **no postalcode rows**) and the
    demo's anchor-centroid fallback (`postcode-us.bin`) must fire instead.
- `note` / `source` (optional strings): provenance + intent.

Schema validation lives in `scripts/eval/demo-cascade-rows.ts` (unit-tested in
`demo-cascade-rows.test.ts`); a malformed row fails LOUD naming the row number.

## Provenance of the initial 21 rows (2026-06-11)

- The three 2026-06-11 bug reproductions (#521/#522): `New York City` (+
  lowercase variant), `Brooklyn`, `brooklyn, new york, ny`.
- The nine demo presets from `docs/src/shared/demo-helpers.ts`
  (`EXAMPLE_ADDRESSES`), including both Berlin orders and the Paris street
  fall-through.
- Bare famous names (`Chicago`, `Seattle`, `San Francisco`, `Berlin`, `Paris`)
  plus known-hard shapes: `Saint Paul, MN` (multi-token locality fragmentation
  kryptonite), `Springfield, IL` (same-name disambiguation — population alone
  picks the MO Springfield), `Washington, DC` (region-abbreviation expansion).

All ids verified against the staged `v4.4.0` `wof-hot.db`
(`/tmp/v440-stage/en-us/v4.4.0/wof-hot.db`, the byte-copy of what the live demo
serves) on 2026-06-11.

## 2026-06-12 expansion: 21 → 39 rows

Added 18 rows covering additional coverage dimensions the slim DB (US/DE/FR only) supports:

- **More US top-10 cities**: `Los Angeles`, `Houston`, `Philadelphia`, `Denver`, `Austin, TX`,
  `Boston`, `Portland, OR` (disambiguation: OR 665K vs ME 69K), `Nashville, TN`.
- **DE cities**: `München`, `Munich` (English alias), `Hamburg`, `Frankfurt am Main`,
  `Frankfurt, Germany` (FTS short-name path).
- **FR cities**: `Lyon`, `Marseille`.
- **Full-address DE/FR/US variants**: `200 E Colfax Ave, Denver, CO 80203` (CO region bbox),
  `1600 Amphitheatre Pkwy, Mountain View, CA 94043` (locality+region within CA),
  `1776 Independence Ave, Philadelphia, PA 19106`.

All 18 new ids verified directly against `/tmp/v440-stage/en-us/v4.4.0/wof-hot.db` on 2026-06-12
via `sqlite3` `spr` table lookup (id, name, placetype, country, lat, lon) before row was written.
39/39 pass rate confirmed by runner on 2026-06-12.
