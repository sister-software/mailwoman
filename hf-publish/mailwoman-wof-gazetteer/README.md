---
license: cc-by-4.0
language:
  - en
  - fr
  - de
  - ja
  - ko
  - zh
task_categories:
  - token-classification
  - text-classification
tags:
  - gazetteer
  - address-parsing
  - whosonfirst
  - wof
  - mailwoman
  - multi-script
pretty_name: Mailwoman WOF Gazetteer
size_categories:
  - 1M<n<10M
---

# Mailwoman WOF Gazetteer

Multi-locale administrative-hierarchy gazetteer for address parsing, derived from [Who's On First](https://whosonfirst.org/). Ships a unified SQLite database plus seven per-locale FST (finite-state transducer) binaries for fast in-process gazetteer lookup.

- **Source code**: https://github.com/sister-software/mailwoman
- **Build pipeline**: [WAL + Freeze design brief](https://github.com/sister-software/mailwoman/blob/main/docs/articles/reviews/2026-05-28-sqlite-wal-strategy.md)
- **License**: CC-BY-4.0 (inherited from upstream WOF)

## Contents

### `admin-global-priority.db` (1.09 GB)

Unified SQLite database for 7 priority countries. Schema mirrors the official geocode.earth WOF distribution for drop-in compatibility.

| Table                             | Rows       |
| --------------------------------- | ---------- |
| `spr` (single-place records)      | 1,288,749  |
| `names` (multi-language variants) | 10,233,886 |
| `concordances` (cross-source IDs) | 2,156,440  |
| `place_population`                | 220,469    |

Countries: US (449K places), CN (680K), FR (231K), DE (189K), GB (73K), JP (63K), KR (54K).

### `fst/fst-{locale}.bin` — per-locale FST gazetteers

Pre-built FST gazetteers for use as Viterbi emission priors in the [mailwoman](https://huggingface.co/sister-software/mailwoman-en-us) neural classifier. Each FST is built from the global SQLite with all-language name variants (CJK, Cyrillic, Arabic, Thai work).

| Locale | File            | Size    | States | Places |
| ------ | --------------- | ------- | ------ | ------ |
| en-US  | `fst-en-us.bin` | 20.9 MB | 160K   | 449K   |
| en-GB  | `fst-en-gb.bin` | 3.7 MB  | 33K    | 73K    |
| fr-FR  | `fst-fr-fr.bin` | 10.2 MB | 72K    | 231K   |
| ja-JP  | `fst-ja-jp.bin` | 13.0 MB | 116K   | 63K    |
| ko-KR  | `fst-ko-kr.bin` | 7.1 MB  | 55K    | 54K    |
| zh-CN  | `fst-zh-cn.bin` | 92.5 MB | 589K   | 680K   |
| de-DE  | `fst-de-de.bin` | 8.1 MB  | 70K    | 189K   |

Binary format: V4 (u32 edge/place counts per state). Decoder: `@mailwoman/resolver-wof-sqlite/fst-serialize`.

## Multi-script support

Token normalization uses Unicode property escapes (`/[\p{P}\p{S}]/gu`) instead of ASCII-only patterns. CJK queries work:

| Query  | Top match                      |
| ------ | ------------------------------ |
| 東京   | region Tokyo (importance 0.98) |
| 北京   | region Beijing (1.00)          |
| 서울   | region Seoul (0.95)            |
| 大阪   | region Osaka (0.94)            |
| パリ   | region Paris (0.79)            |
| москва | locality Moscow                |

## Build provenance

| Field                   | Value                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------ |
| Source                  | Who's On First admin repos (cloned via `gh repo list whosonfirst-data --limit 1000`) |
| Build script            | `scripts/build-unified-wof.ts`                                                       |
| Build pipeline          | WAL → checkpoint → DELETE → ANALYZE → VACUUM INTO                                    |
| GeoJSON files processed | 1,743,963 (alt-geometries excluded)                                                  |
| Build time              | 185s on a single workstation                                                         |

## Usage (JavaScript)

```js
import { deserializeFst } from "@mailwoman/resolver-wof-sqlite/fst-serialize"
import { readFileSync } from "node:fs"

const buf = readFileSync("./fst-en-us.bin")
const matcher = deserializeFst(buf)
const result = matcher.query("new york")
// → { accepting: [{ placetype: "region", name: "New York", importance: 1.0 }, ...] }
```

## Usage (SQLite direct)

```sql
SELECT s.name, s.placetype, s.latitude, s.longitude
FROM spr s
JOIN names n ON n.id = s.id
WHERE n.language = 'jpn' AND n.name = '東京'
LIMIT 5;
```

## Updates

Rebuilt periodically as WOF upstream changes. Tagged versions track the source-repo commit hashes at build time.

## License

CC-BY-4.0. When redistributing, attribute Who's On First and link to https://whosonfirst.org/.
