# Repo-wide taste audit — design

**Date:** 2026-08-02
**Status:** design approved, sweep in progress
**Deliverable:** `docs/superpowers/specs/2026-08-02-taste-audit-findings.md`, which ranks clusters of
duplicated logic and idiom drift. Each cluster has `file:line` receipts and a proposed owning module. This
pass changes no code.

## The question

The repo has 1,573 tracked TS/TSX files and ~286k LOC across 41 workspaces. `AGENTS.md` declares an
owning module for most of the shared implementation: `APIClient` for HTTP, `dataRootPath` for data-root
paths, `core/env` for environment access, `cli-kit` for CLI components, Kysely's `DatabaseClient` for
DDL, `@mailwoman/spatial` for geo math, `@mailwoman/annotations` for the annotation interface,
`api-kit` for HTTP plumbing.

An agent implementing a feature sees the file it was pointed at and its immediate neighbours. It does
not see the workspace three directories over that already solved the same problem. The agent then
rebuilds the implementation locally as a second haversine, a second env reader, or a second retry loop,
and each copy drifts independently.

This audit finds those copies and proposes an owning module for each one.

## What was measured before designing

Probes run 2026-08-02 against `origin/main` @ `9b46c82e`.

### Scale

| metric                                | value   |
| ------------------------------------- | ------- |
| tracked `.ts`/`.tsx` (excluding data) | 1,573   |
| total LOC                             | 286,434 |
| workspaces                            | 41      |

### Probe — great-circle distance

`AGENTS.md` calls `@mailwoman/spatial` "the math home — haversine, bbox, projection". Grepping for
lat/lon trigonometry outside `spatial/` returns hits in seven files across three workspaces:

```
mailwoman/gazetteer-pipeline/postcode-locality/{base,jp,kr,tw}.ts
resolver-wof-sqlite/geo.ts
resolver-wof-sqlite/street-centroid.ts
match/distance.ts
```

Reading `match/distance.ts:25` shows that it is a documented adapter
from `match`'s `LatLon` shape onto `greatCircleKm` in `spatial`, and its docstring says so. It does not reimplement the formula. Grep
alone would have produced a false finding from its first candidate.

That result sets the method for the whole sweep: **grep generates candidates, and reading produces
findings.** Every entry in the findings doc has been read.

## Approach

Three options were considered:

| approach                   | strength                                           | weakness                                                           |
| -------------------------- | -------------------------------------------------- | ------------------------------------------------------------------ |
| A — declared-home spine    | precise, complete for every home `AGENTS.md` names | blind wherever no home was ever declared                           |
| B — clone/similarity sweep | recall on duplication nobody anticipated           | noisy; flags fixtures, generated blobs, deliberately-parallel code |
| C — read every workspace   | best judgment                                      | 286k LOC does not fit                                              |

**Chosen: A and B generate candidates, and C's close reading covers only the ranked shortlist.** A gives
precision, B gives recall on duplication without a declared home, and the expensive read happens only where a candidate
already exists.

## The four finding axes

1. **Declared-home violation**: logic reimplemented locally when `AGENTS.md` declares an owning module.
   The declared homes are `APIClient`, `dataRootPath`/`dataRootPath`, `core/env`, `cli-kit`, `test-kit`,
   Kysely `DatabaseClient` with the co-located schema builders, `@mailwoman/spatial`,
   `@mailwoman/annotations`, and `api-kit`.

2. **Orphan duplication**: the same logic in two or more places without a declared home. A finding on
   this axis is incomplete until it proposes the module the logic should move to.

3. **Idiom drift**: code that violates repo conventions. The conventions are acronym casing (`parseJSON` rather than
   `parseJson`), `erasableSyntaxOnly` (which forbids `enum`, constructor parameter properties, and runtime
   namespaces), explicit `.ts` extensions on relative imports, the schema builder instead of raw DDL where it
   applies, `dataRootPath` instead of a re-hardcoded `$MAILWOMAN_DATA_ROOT`, and `core/env` instead of raw `process.env` / `process.argv`.

4. **Altitude and boundaries**: modules that have grown past one purpose, or whose internals leak
   into consumers.

## Out of scope

- **Bug hunting**, which is the job of `/code-review`. A duplicated function that is also wrong is
  reported as duplication, and the defect is noted without being investigated.
- Performance work, prose and docs style, `data/`, generated model blobs, and `corpus-python`.
- Everything on the `AGENTS.md` "What deliberately stays raw" list: FTS5 `MATCH`, ogr2ogr dialect
  SQL, the hot positional INSERT loops, runtime-dynamic schemas, introspect-and-replay,
  async-into-sync walls, and the sync-by-interface resolver readers. These are documented decisions with
  stated reasons, and migrating any of them would make it worse. The audit treats the list as an allowlist rather than a backlog.

## Ranking

Each cluster gets two independent scores, reported separately rather than combined:

- **Cost of leaving it**: the number of copies multiplied by how likely they are to drift apart. Seven copies of a
  formula that will never change cost less to leave than two copies of a rule that changes per
  locale.
- **Cost of fixing it**: lines touched, packages crossed, whether a public export moves, and whether
  the change is mechanical or needs judgment at each site.

## Output

`docs/superpowers/specs/2026-08-02-taste-audit-findings.md` contains:

- An executive summary with the cluster count, the site count, and the shortlist to do first.
- One section per cluster with the duplicated logic, every `file:line`, the proposed owning module,
  both costs, and whether the fix is mechanical.
- A **rejected-candidates appendix** that lists every candidate grep found and reading ruled out, with
  the reason. `match/distance.ts` is the first entry. The appendix matters most: without it, the next
  agent proposes the same false findings again, and this audit has to be re-run from scratch.
