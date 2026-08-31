---
name: wof-build
description: Unified WOF SQLite pipeline. Chains build-unified-wof, build-importance, FST build, and stats report. Use when rebuilding WOF data artifacts after a GeoJSON repo update or importance score refresh.
---

## Purpose

End-to-end WOF data rebuild pipeline. Eliminates manual multi-step orchestration
that was error-prone in the v0.5.2/v0.5.3 sessions (forgot importance step, stale FST, etc.).

## Prerequisites

- WOF GeoJSON repos cloned to `/mnt/playpen/mailwoman-data/wof/repos/` (or `$WOF_REPOS_DIR`)
- WOF admin SQLite at `/mnt/playpen/mailwoman-data/wof/whosonfirst-data-admin-us-latest.db` (or `$WOF_ADMIN_DB`)
- Compiled workspace: `yarn compile`

## Pipeline steps

### 1. Build unified SQLite from GeoJSON repos (optional, ~45s)

Only needed when GeoJSON repos have been updated. Skip if the existing unified DB is current.

```bash
node packages/mailwoman/out/cli.js wof prepare /mnt/playpen/mailwoman-data/wof/repos/ \
  --unified-db /mnt/playpen/mailwoman-data/wof/whosonfirst-data-admin-us-unified.db
```

### 2. Build Wikipedia importance scores (~15s)

Downloads wikimedia-importance.csv.gz, joins WOF concordances, writes `place_importance` table.

```bash
node packages/mailwoman/out/cli.js gazetteer importance --db $MAILWOMAN_DATA_ROOT/wof/admin-global-priority.db
```

**This step must precede step 3. Check whether it has ever run against the live admin DB:** while
`admin-global-priority.db` carries `place_population` and no `place_importance`, the FST builder
takes its documented fallback and every shipped FST's `importance` is population-scaled. In that
state a rebuild reproduces importance values bit-identically across admin swaps, and the
`place_population` row counts match the provenance field both builds record as `importanceMatches`.
See #1142.

### 3. Build the per-locale FST gazetteers (~4 min, mostly the shared ambiguity scan)

Use the CLI, not a hand-rolled `node -e`. It applies the degenerate-surface curation, runs the
surface-ambiguity scan once across all locales, and stamps the source DB's md5 into each artifact's
provenance trailer (see step 5).

```bash
node packages/mailwoman/out/cli.js gazetteer build fst \
  --output $MAILWOMAN_DATA_ROOT/wof/fst-staging-$(date -u +%F)
```

Builds `fst-{en-us,fr-fr,en-gb,de-de}.bin` — the `FST_LOCALES` set. Output goes to a STAGING dir and
the swap into `fst-per-locale/` is operator-gated: an FST changes decoder behaviour, so it moves
after the battery, not as a side effect of a build.

**`fst-global-priority.bin` and the CJK three (`fst-{ja-jp,zh-cn,ko-kr}.bin`) have no builder.** They
predate `FST_LOCALES` (#1318) and nothing in the tree can regenerate them; the freshness check in
step 5 reports them as stale with `NO BUILDER` rather than pretending a command exists.

### 4. Build slim WOF DB for browser (~20s)

```bash
node resolver-wof-sqlite/out/build-slim-cli.js \
  --in /mnt/playpen/mailwoman-data/wof/whosonfirst-data-admin-us-latest.db \
  --in /mnt/playpen/mailwoman-data/wof/whosonfirst-data-postalcode-us-latest.db \
  --out docs/static/mailwoman/wof-hot.db \
  --top 1000
```

### 5. Verify

The FST freshness section of `gazetteer verify` answers "which artifacts were built from THIS
database" — the question that, while unanswerable, once left every FST pointing at a gazetteer
that no longer existed after an admin swap:

```bash
node packages/mailwoman/out/cli.js gazetteer verify --no-reverse-panel
```

It compares each artifact's stamped `sourceDBMD5` against the DB on disk. The section is ADVISORY —
it never changes the exit code, because a stale FST says nothing about whether the database is sound,
and a dev tree with an old bias list must still run. The same check runs from the weights linkers
(`neural-weights-{en-us,en-gb,fr-fr}/scripts/link-dev-weights.ts`), so `yarn test` surfaces the drift
too.

```bash
# Query smoke on a staged artifact
node --input-type=module -e "
import { readFile } from 'node:fs/promises'
import { deserializeFST } from '@mailwoman/resolver-wof-sqlite/fst-serialize'
import { peekFSTStampFields } from '@mailwoman/resolver-wof-sqlite/fst-freshness'
const path = process.env.FST
console.log('stamp:', JSON.stringify((await peekFSTStampFields(path))?.provenance))
const matcher = deserializeFST(await readFile(path))
console.log('States:', matcher.stateCount, 'Places:', matcher.placeCount)
const r = matcher.query('new york')
console.log('New York:', r.accepting.length, 'interpretations')
for (const p of r.accepting.slice(0, 3)) console.log(' ', p.placetype, p.name, 'imp:', p.importance.toFixed(3))
"
```

**Watch `importanceMatches` in the stamp.** The builder falls back to `place_population` when the DB
has no `place_importance` table, and no admin DB has ever carried one (#1142) — so the FST's
`importance` field is population-scaled, not Wikipedia importance, and the provenance field counts
population rows rather than importance matches. Step 2 exists to fix that; until it runs against the
live DB, that is what the number means.

## Expected output

Measured against `admin-global-priority.db` md5 `1e963a54`:

| Artifact      | Size    | States  | Places  | Insertions | Excluded |
| ------------- | ------- | ------- | ------- | ---------- | -------- |
| fst-en-us.bin | 21.8 MB | 160,246 | 236,257 | 274,245    | 3,383    |
| fst-fr-fr.bin | 9.4 MB  | 63,664  | 101,601 | 105,711    | 270      |
| fst-en-gb.bin | 3.9 MB  | 32,604  | 41,821  | 43,913     | 174      |
| fst-de-de.bin | 8.1 MB  | 66,048  | 84,701  | 85,534     | 333      |
| wof-hot.db    | ~35 MB  | —       | —       | —          | —        |

A rebuild that reproduces those five numbers per locale is a no-op except for parent chains and the
stamp — the counts held exactly across the admin swap that added macrohood records, because `macrohood`/`microhood` are
not in the builder's `DEFAULT_PLACETYPES`. The ingest still reaches the artifact, but only as ancestry:
2,602 US / 67 GB / 19 FR neighbourhood chains grew from one hop to the full walk once their macrohood
parents existed to walk through.

## When to run

- After updating WOF GeoJSON repos
- After refreshing wikimedia-importance scores
- Before a model release (ensures demo assets are current)
- After changing the FST builder or serialization format
- **After any `admin-global-priority.db` swap** — that is what invalidates every FST, and step 5's
  freshness check is what tells you it happened
