# Repo-wide taste audit — design

**Date:** 2026-08-02
**Status:** design approved, sweep in progress
**Deliverable:** `docs/superpowers/specs/2026-08-02-taste-audit-findings.md` — ranked clusters of
duplicated logic and idiom drift, each with `file:line` receipts and a proposed owning module. No
code changes in this pass.

## The question

The repo has 1,573 tracked TS/TSX files and ~286k LOC across 41 workspaces. `AGENTS.md` declares an
owning module for most of the shared machinery: `APIClient` for HTTP, `dataRootPath` for data-root
paths, `core/env` for environment access, `cli-kit` for CLI components, Kysely's `DatabaseClient` for
DDL, `@mailwoman/spatial` for geo math, `@mailwoman/annotations` for the annotation contract,
`api-kit` for HTTP plumbing.

An agent implementing a feature sees the file it was pointed at and its immediate neighbours. It does
not see the workspace three directories over that already solved the same problem. So the machinery
gets rebuilt locally — a second haversine, a second env reader, a second retry loop — and each copy
drifts on its own schedule.

This audit finds those copies and names where each belongs.

## What was measured before designing

Probes run 2026-08-02 against `origin/main` @ `9b46c82e`.

### Scale

| metric                                | value   |
| ------------------------------------- | ------- |
| tracked `.ts`/`.tsx` (excluding data) | 1,573   |
| total LOC                             | 286,434 |
| workspaces                            | 41      |

### Probe — great-circle distance

`AGENTS.md` names `@mailwoman/spatial` "the math home — haversine, bbox, projection". Grepping for
lat/lon trigonometry outside `spatial/` returns hits in seven files across three workspaces:

```
mailwoman/gazetteer-pipeline/postcode-locality/{base,jp,kr,tw}.ts
resolver-wof-sqlite/geo.ts
resolver-wof-sqlite/street-centroid.ts
match/distance.ts
```

Reading `match/distance.ts:25` shows it is **not** a reimplementation — it is a documented adapter
from `match`'s `LatLon` shape onto `greatCircleKm` in `spatial`, and says so in its docstring. Grep
alone would have shipped a false finding on the first candidate it produced.

That result sets the discipline for the whole sweep: **grep generates candidates, reading produces
findings.** Nothing enters the findings doc unread.

## Approach

Three options were considered:

| approach                   | strength                                           | weakness                                                           |
| -------------------------- | -------------------------------------------------- | ------------------------------------------------------------------ |
| A — declared-home spine    | precise, complete for every home `AGENTS.md` names | blind wherever no home was ever declared                           |
| B — clone/similarity sweep | recall on duplication nobody anticipated           | noisy; flags fixtures, generated blobs, deliberately-parallel code |
| C — read every workspace   | best judgment                                      | 286k LOC does not fit                                              |

**Chosen: A + B generate candidates; C's judgment is spent only on the ranked shortlist.** A gives
precision, B gives recall on the unnamed, and the expensive read happens only where a candidate
already exists.

## The four finding axes

1. **Declared-home violation** — logic reimplemented locally when `AGENTS.md` names an owning module.
   Register: `APIClient`, `dataRootPath`/`mailwomanDataRoot`, `core/env`, `cli-kit`, `test-kit`,
   Kysely `DatabaseClient` + the co-located schema builders, `@mailwoman/spatial`,
   `@mailwoman/annotations`, `api-kit`.

2. **Orphan duplication** — the same logic in two or more places with no declared home. A finding on
   this axis is incomplete unless it names the module the logic should move to.

3. **Idiom drift** — repo conventions the code violates: acronym casing (`parseJSON`, not
   `parseJson`), `erasableSyntaxOnly` (no `enum`, no constructor parameter properties, no runtime
   namespaces), explicit `.ts` extensions on relative imports, raw DDL where the schema builder
   applies, re-hardcoded `/mnt/playpen`, raw `process.env` / `process.argv`.

4. **Altitude and boundaries** — modules that have grown past one purpose, or whose internals leak
   into consumers.

## Out of scope

- **Bug hunting.** That is `/code-review`'s job. A duplicated function that is also wrong gets
  reported as duplication; the wrongness is noted, not chased.
- Performance work, prose and docs style, `data/`, generated model blobs, `corpus-python`.
- Everything on the `AGENTS.md` "What deliberately stays raw" list. FTS5 `MATCH`, ogr2ogr dialect
  SQL, the hot positional INSERT loops, runtime-dynamic schemas, introspect-and-replay,
  async-into-sync walls, the sync-by-interface resolver readers. These are documented decisions with
  reasons attached. Migrating one regresses it. They are an allowlist, not a backlog.

## Ranking

Each cluster scores on two independent quantities, reported separately rather than collapsed:

- **Cost of leaving it** — number of copies × how likely they are to drift apart. Seven copies of a
  formula that will never change is cheaper to leave than two copies of a rule that changes per
  locale.
- **Cost of fixing it** — lines touched, packages crossed, whether a public export moves, whether
  the change is mechanical or needs judgment per site.

## Output

`docs/superpowers/specs/2026-08-02-taste-audit-findings.md`:

- Executive summary — cluster count, site count, the shortlist worth doing first.
- One section per cluster — what the duplication is, every `file:line`, the proposed owning module,
  both costs, and whether the fix is mechanical.
- **Rejected-candidates appendix** — every candidate that survived grep and died on reading, with
  the reason. `match/distance.ts` is entry one. This appendix is the point: without it the next
  agent re-proposes the same false findings, and this audit gets re-run from scratch.
