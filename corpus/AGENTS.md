# AGENTS.md — `@mailwoman/corpus`

Scope notes for the training-corpus pipeline. The repo-wide rules live in the root `AGENTS.md`; this
file covers what is specific to acquiring source data and turning it into shards, and it exists
because each item below cost a real investigation to establish.

## Acquiring OpenAddresses data

OA has **two** distribution endpoints with different access rules, and picking the wrong one either
blocks you on a credential or costs a multi-gigabyte download for a single county:

- **Country collections** — `batch.openaddresses.io`, reached by
  `mailwoman corpus fetch openaddresses --country <cc>`. Requires a free registered account;
  `fetchOpenAddresses` reads `OA_BATCH_TOKEN`. Granularity is a whole country (US is many GB).
- **Per-source runs** — `https://results.openaddresses.io/latest/run/<path>.zip`, e.g.
  `.../latest/run/us/ia/statewide.zip`. **Anonymous, no token**, and honors range requests. `<path>`
  is exactly the member path the recipe names, so `oa-cache/us__ia__statewide.zip` ⇄
  `us/ia/statewide.csv` ⇄ `/latest/run/us/ia/statewide.zip`.

The auth gate is on collections only. If you need a handful of named sources, use the per-source
endpoint — all seven `us__*` sources the recipes read total ~117 MB.

`HEAD` against the per-source endpoint returns no `Content-Length` (it redirects). To size one
without downloading it, issue a one-byte range GET and read `Content-Range`.

## A file's mtime is not its data's vintage

`$MAILWOMAN_DATA_ROOT/openaddresses/europe.zip` has a 2021 mtime, which reads as five-year-old data
and has been proposed for refresh on that basis. It is not stale: `fr/countrywide.csv`,
`de/berlin.csv` and `de/sn/statewide.csv` are **byte-identical** to what OA's current run serves
(`bf624492…`, `9903d438…`, `623b099b…`). The date records when someone downloaded the archive.

Before proposing a source refresh — which changes shard bytes and therefore lands in retrain
territory — `md5sum` the member against the current run. It costs one command and has already
prevented one retrain proposed over a file timestamp.

## The embedded-newline census

A CSV value may contain a newline (inside a quoted field). Whether any given source actually does is
a property of the DATA, not of the code, so measure rather than argue:

```sh
unzip -p <zip> <csv> | awk '{n=gsub(/"/,"&"); if(n%2==1) odd++} END{print FILENAME, NR, odd+0}'
```

Full results are in `docs/superpowers/specs/2026-08-02-taste-audit-findings.md`. The short version:
of every source reachable on the lab host, only two carry any — `fr/countrywide.csv` has 1 record and
`us/ia/statewide.csv` has 12, all unit designators like `"#2\n#2"`. Everything else is zero.

Two consequences worth not rediscovering:

- **`readCSVRecords` collapses `\r\n` inside a value to a space**, and is deliberately scoped to
  `\r\n` rather than `\s`. The quote-blind splitter it replaced was acting as an accidental newline
  sanitizer — those IA records used to split in two and get dropped by the field checks. Widening the
  collapse to `\s+` also rewrites `NORTH   MAIN STREET` on rows with no line break at all, silently
  changing values in every shard. `scaffold.test.ts` pins both directions.
- **Line-based pre-filters run BEFORE the parser and can cut a record in half.** `po-box-cedex`'s
  `awk 'NR%211==3'` stride and the `head -n` caps elsewhere count PHYSICAL lines. The parse cannot
  repair what the pre-filter already cut; a halved record fails the field checks and drops. This is a
  sampling artefact, not a correctness bug, and it is documented at the call site. FR gets away with
  it by luck — neither physical line of its one multi-line record is `≡ 3 (mod 211)`.

## `spliterator` ≥ 5.0.0 is a hard floor

Do not re-introduce buffer windowing around `CSVSpliterator.from`. It existed because `searchMatches`
re-scanned the whole buffer per delimiter before 5.0.0 — quadratic, and the pathological input was
the ORDINARY one (a source with no quotes at all paid a full scan per row). Measured on a real OA
extract: 8 MB took 27,405 ms on 4.0.0 and 175 ms on 5.0.0. Streaming callers never saw it because
they were chunk-bounded; only a whole-buffer `.from()` exposed it.

5.0.0 also aligned `normalizeKeys`' default between `from` (was `undefined`) and `fromAsync` (was
`mode !== "array"`) — the same options object previously produced different keys per entry point.
Note that `normalizeKeys` does NOT lowercase: `smartSnakeCase` leaves ALL CAPS alone, and OA ships
`LON,LAT,NUMBER,STREET`. That is why `readCSVRecords` owns the lower-casing itself.

## Before claiming a built shard needs rebuilding

Shards are build outputs under `$MAILWOMAN_DATA_ROOT/corpus/shards/`, not committed artifacts. Two
checks, one command each, before asserting that a code change invalidates one:

1. **Is that reader on the changed path?** Several recipes read the same source through different
   readers. `locale.ts` has its own `CSVSpliterator` reader and is not among `readCSVRecords`' callers.
2. **Does the artifact predate the fix?** Compare the shard's mtime against the commit date of the
   change. A shard built after a fix already contains it.

Skipping both once produced a claim that `synth-es-pedania-v1.jsonl` needed re-pinning. Its reader
had migrated on 2026-07-08 and the shard was built 2026-07-22 — the work was already done, and acting
on the claim would have cost an 800,000-row rebuild to find that out.
