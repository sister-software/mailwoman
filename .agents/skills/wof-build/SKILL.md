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
node mailwoman/out/cli.js wof prepare /mnt/playpen/mailwoman-data/wof/repos/ \
  --unified-db /mnt/playpen/mailwoman-data/wof/whosonfirst-data-admin-us-unified.db
```

### 2. Build Wikipedia importance scores (~15s)

Downloads wikimedia-importance.csv.gz, joins WOF concordances, writes `place_importance` table.

```bash
node scripts/build-importance.js --db /mnt/playpen/mailwoman-data/wof/whosonfirst-data-admin-us-latest.db
```

### 3. Build FST gazetteer binary (~3s)

```bash
node -e "
import { buildFstFromWof } from '@mailwoman/resolver-wof-sqlite/fst-builder'
import { serializeFst } from '@mailwoman/resolver-wof-sqlite/fst-serialize'
import { writeFileSync } from 'node:fs'
const { matcher, result } = buildFstFromWof({
  dbPath: '/mnt/playpen/mailwoman-data/wof/whosonfirst-data-admin-us-latest.db',
  countries: ['US'],
  onProgress: (phase, msg) => console.error(phase + ': ' + msg),
})
const buf = serializeFst(matcher)
writeFileSync('docs/static/mailwoman/fst-en-US.bin', buf)
console.log('FST: ' + (buf.length / 1024 / 1024).toFixed(2) + ' MB, ' + result.stateCount + ' states, ' + result.placeCount + ' places')
"
```

### 4. Build slim WOF DB for browser (~20s)

```bash
node resolver-wof-sqlite/out/build-slim-cli.js \
  --in /mnt/playpen/mailwoman-data/wof/whosonfirst-data-admin-us-latest.db \
  --in /mnt/playpen/mailwoman-data/wof/whosonfirst-data-postalcode-us-latest.db \
  --out docs/static/mailwoman/wof-hot.db \
  --top 1000
```

### 5. Verify

```bash
# FST query test
node -e "
import { readFileSync } from 'node:fs'
import { deserializeFst } from '@mailwoman/resolver-wof-sqlite/fst-serialize'
const buf = readFileSync('docs/static/mailwoman/fst-en-US.bin')
const matcher = deserializeFst(buf)
console.log('States:', matcher.stateCount, 'Places:', matcher.placeCount)
const r = matcher.query('new york')
console.log('New York:', r.accepting.length, 'interpretations')
for (const p of r.accepting.slice(0, 3)) console.log(' ', p.placetype, p.name, 'imp:', p.importance.toFixed(3))
"

# Report sizes
ls -lh docs/static/mailwoman/
```

## Expected output

| Artifact      | Size   | Contents                               |
| ------------- | ------ | -------------------------------------- |
| fst-en-US.bin | ~9 MB  | 60K states, 94K+ places                |
| wof-hot.db    | ~35 MB | Top-1000 US localities + all postcodes |

## When to run

- After updating WOF GeoJSON repos
- After refreshing wikimedia-importance scores
- Before a model release (ensures demo assets are current)
- After changing the FST builder or serialization format
