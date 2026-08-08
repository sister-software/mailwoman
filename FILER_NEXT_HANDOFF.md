# filer.db next steps — handoff for DeepSeek

**Written** 2026-08-08 · **Workspace** `@mailwoman/filer` · **Predecessor** `EDGAR_HANDOFF.md` (repo root — read it first; its Doctrine and Traps sections bind here too)

The crosswalk artifact EXISTS now. This doc is the work that comes after it: four tasks, in
priority order, each with explicit steps, verification commands, and stop conditions. Do them
one at a time, in order, and verify each before starting the next.

**Ways of working, non-negotiable:**

- **Verify before claiming.** Run the command, paste the output into your report. A claim
  without its command is treated as false here.
- **When a step's verification fails, STOP that task and write down what happened.** Do not
  improvise around it. A blocked task with a clear note is a good outcome; a workaround that
  guesses is not.
- **Never edit `expected.json` files, never generate a fixture expectation from the code under
  test, and mutation-verify every new rule** (break it, watch the test fail, restore).
- Commit small. One logical change per commit. Push to a branch and open a PR — do NOT push
  to main directly.
- All the repo conventions from `EDGAR_HANDOFF.md` §"Repo conventions you will trip on" apply.

---

## The state of the world

| artifact          | where                                                                               | contents                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `filer.db`        | `/mnt/playpen/mailwoman-data/filer/filer.db` (36.8 MB, sealed read-only, schema v3) | 45,215 nodes · 31,605 edges · 6,929 families · 207,500 attributes                                |
| its manifest      | `filer.db.manifest.json` beside it                                                  | build counts, exactly as reported                                                                |
| EDGAR rows        | `/tmp/edgar-out-final/edgar-subsidiaries.jsonl` (2,897 rows)                        | ⚠ `/tmp` — copy to `/mnt/playpen/mailwoman-data/filer/` FIRST, it will not survive a reboot      |
| Form 499 workbook | `/mnt/playpen/mailwoman-data/fcc/form499/499-filer-db-2025-12-07.xlsx`              | 19,852 filers, provenance + md5 beside it                                                        |
| CIK index         | `/tmp/cik-lookup.txt` (40 MB)                                                       | also `/tmp` — refetchable from `https://www.sec.gov/Archives/edgar/cik-lookup-data.txt`, no auth |
| bdc.db machinery  | `bdc/` workspace                                                                    | builder + reader exist; one CA-pilot artifact was built in Phase 2a                              |

The edge vocabulary in `filer.db`, so you know what you are querying:

```
same_entity         18,953   FRN ↔ form499ID          form-499       authoritative
holding_company      5,752   FRN → holding co name    form-499       authoritative
subsidiary           2,894   CIK → subsidiary name    edgar-exhibit-21
superseded_by        2,826   old form499ID → new      form-499       (from the lifecycle notes)
management_company     812   FRN → mgmt co name       form-499
parent_company         368   family rollup            edgar-exhibit-21
```

1,837 edges carry a closed `valid_to`; readers must use the half-open predicate
`valid_from <= asOf AND (valid_to IS NULL OR asOf < valid_to)` — `filer/sdk/filer-lookup.ts`
already does.

---

## Task 0 (five minutes, do it first): move the /tmp artifacts to durable storage

```bash
cp /tmp/edgar-out-final/edgar-subsidiaries.jsonl /mnt/playpen/mailwoman-data/filer/edgar-subsidiaries-2026-08-07.jsonl
cp /tmp/cik-lookup.txt /mnt/playpen/mailwoman-data/sec/cik-lookup-data-2026-08-07.txt
md5sum /mnt/playpen/mailwoman-data/filer/edgar-subsidiaries-2026-08-07.jsonl > /mnt/playpen/mailwoman-data/filer/edgar-subsidiaries-2026-08-07.jsonl.md5
```

Verify: `wc -l` the copied JSONL — it must say 2897. Write a short `PROVENANCE.md` beside it
following the pattern in `/mnt/playpen/mailwoman-data/fcc/form499/PROVENANCE.md`.

---

## Task 1: Datasette Lite exploration package

**Goal:** anyone with a browser can explore filer.db — no install, no server of ours.

Datasette Lite (https://lite.datasette.io) runs Datasette in the browser via Pyodide/WASM and
loads a SQLite file from a URL: `https://lite.datasette.io/?url=<CORS-accessible-db-url>`.
36.8 MB is within its workable range (it downloads the whole file into browser memory).

### Constraints you must respect

1. **The DB must be served with CORS (`Access-Control-Allow-Origin: *`).** The repo already
   publishes public artifacts to the `nexus-assets` R2 bucket — read
   `docs/engineering/reference/coverage-overlay.mdx` §publish for the exact rclone
   incantation. ⚠ The `RCLONE_S3_PUBLIC_*` env keys write `nexus-assets`; the plain
   `RCLONE_S3_*` keys 403 on it. This trap is documented in that file — believe it.
2. **Publishing this file makes it PUBLIC.** The data is all US-federal public record, so
   that is fine IN PRINCIPLE, but the go/no-go is the operator's: **ask before the upload
   step, present what the file contains, and wait.** Everything before the upload (building
   the enriched DB, testing locally) needs no permission.
3. **Do not modify filer.db.** It is a sealed artifact (mode 0444). Datasette wants a few
   extras (metadata, canned queries) — build a COPY with those added, never touch the
   original. Suggested name: `filer-explore.db`.

### Steps

1. Copy `filer.db` to a scratch dir, `chmod u+w` the copy.
2. Add a `datasette_metadata`-style experience via **canned queries in a metadata.json**
   rather than editing the DB. Datasette Lite accepts `&metadata=<url-to-metadata.json>`.
   Write `filer-explore-metadata.json` with at least these canned queries (test each with
   `sqlite3` first — paste the output in your report):

   - **who-owns**: given an FRN, every relationship edge out of it with source + dates.
     ```sql
     SELECT e.relationship, n.identifier_value AS target, e.source, e.valid_from, e.valid_to
     FROM filer_edge e JOIN filer_node n ON n.node_id = e.to_node_id
     WHERE e.from_node_id = 'frn:' || :frn
     ```
   - **family-members**: given a family_id, its members with display names
     (`filer_family` joined through `naming_node_id`).
   - **supersession-chain**: a recursive CTE walking `superseded_by` edges from a
     given form499 ID (chains are 1–5 deep, no cycles — verified).
   - **acquisitions-by-year**: `superseded_by` edges grouped by `substr(valid_from,1,4)`.
   - **biggest-families**: family_id, member count, display name, ordered desc.

3. Test locally BEFORE any upload: `pip install datasette` (or use the venv at
   `/tmp/claude-1000/*/scratchpad/venv` if it survives) and run
   `datasette filer-explore.db -m filer-explore-metadata.json` — every canned query must
   return rows without error.
4. **STOP. Ask the operator for the publish go-ahead**, showing what the file contains.
5. On approval: upload DB + metadata.json to `nexus-assets` per the coverage-overlay doc,
   verify the URL serves with CORS (`curl -sI <url> | grep -i access-control`), and
   construct the Datasette Lite link:
   `https://lite.datasette.io/?url=<db-url>&metadata=<metadata-url>`.
6. Add a short section to `docs/records/evals/2026-08-07-edgar-live-ingest.md` with the link
   (this page is PUBLIC once merged — that is already true of the rest of it).

**Definition of done:** the Lite link loads in a browser, the who-owns query for
`0001753557` returns the three-row WOW! answer (parent_company from EDGAR + holding_company
from Form 499 + same_entity), and the operator approved the upload.

---

## Task 2: BDC provider list — the bridge to "who serves this address"

**Goal:** get the BDC provider list (provider_id ↔ FRN ↔ brand name) onto disk and into
`filer.db`, closing the loop between corporate identity and service availability.

**Why this is the highest-value data task:** `filer.db` speaks FRN; `bdc.db` speaks
`provider_id`. The provider list is the only join between them. `buildFilerDatabase` ALREADY
accepts `providerRows`/`providerListPath` and writes `bdc_provider` nodes + `same_entity`
edges — the ingestion code is written and tested, only the DATA is missing.

### Steps

1. The BDC API base is `https://broadbandmap.fcc.gov/api/public` (`bdc/sdk/client.ts:52`),
   credentials `FCC_MAP_USERNAME`/`FCC_MAP_API_KEY` in `.env` (working — Phase 2a used them).
   Find the provider-list endpoint: `bdc/sdk/` has `listAvailabilityFiles`-style discovery;
   the provider list is served as a downloadable file in the same downloads API family.
   `filer/sdk/provider-list.ts` documents the CSV columns `parseProviderList` expects —
   the file you want is the one that matches that shape.
2. Download via `createBDCClient()` — never raw fetch. Save to
   `/mnt/playpen/mailwoman-data/fcc/bdc-provider-list/` with a `PROVENANCE.md` and md5.
3. Rebuild filer.db with all three sources. Model the build on the (deleted, but described
   in `docs/records/evals/2026-08-07-edgar-live-ingest.md` §artifact) one-off script:
   `buildFilerDatabase({ form499Rows: <workbook>, edgarRows: <jsonl>, providerListPath: <csv>, ... })`.
   ⚠ Two traps, both hit on the first build:
   - 17 of 19,852 workbook rows have a blank `lastFiledAt` — filter them out of the stream
     (valid_from is mandatory; the builder throws on blanks, correctly).
   - `providerRows` requires `validFrom` to be set on the options (ISO date). Use the
     provider list's own published vintage date, NOT today.
4. Verify against the previous artifact: node/edge counts must be a SUPERSET (all previous
   counts plus new `bdc_provider_id` nodes and their edges). Paste both manifests.
5. Spot-check the loop end to end: pick one provider_id from the BDC CA-pilot data, walk
   provider_id → FRN → holding company in SQL, paste the result.

**Definition of done:** a rebuilt filer.db whose manifest shows `bdc-provider-list` among
sources, with the spot-check walk pasted.

---

## Task 3: CORES enrichment sweep

**Goal:** a second name + address per FRN, cached on disk, for the future record-matcher work.

The client exists and is tested (`filer/sdk/cores-client.ts`). This is a patience task, not a
code task:

1. Extract all distinct FRNs from filer.db:
   `sqlite3 filer.db "SELECT identifier_value FROM filer_node WHERE identifier_type='frn'"`
   → 18,655.
2. Write a small runner that calls `fetchCORESRegistration(createCORESClient(), frn)` for
   each, collecting results to JSONL. The client paces at 4 req/s and caches to
   `dataRootPath("fcc", "cores", "cache")` — a re-run after interruption is nearly free.
   Expect ~78 minutes. Run it with `nohup` or in a way that survives your session.
3. Count outcomes: records found, no-record nulls, errors. `null` is an abstention, not a
   failure — report the split, do not retry nulls.
4. Save to `/mnt/playpen/mailwoman-data/fcc/cores/registrations-<date>.jsonl` + PROVENANCE.

**Do NOT write CORES data into filer.db yet.** How it lands (attributes vs a new source's
edges) is a schema decision the operator hasn't made. Collect and report only.

**Definition of done:** the JSONL exists with ≥90% of FRNs attempted, outcome counts pasted.

---

## Task 4 (stretch): the C4 positioning eval draft

Only if Tasks 0–3 are done and verified. Draft — do not publish — a public-facing writeup of
the crosswalk pipeline for `docs/records/evals/`: what was built, the measured numbers (all
already in the two existing eval pages), the doctrine (documented relationships only,
disclosure never accusation, abstention never guessed). Mark it DRAFT in the H1 and tell the
operator it exists. The go/no-go on publishing is theirs, same as every public artifact.

---

## What NOT to do

- Do not touch `resolveCIKCandidates`' tie rule, the SIC gate's allowlist, or
  `OWNERSHIP_BY_RELATIONSHIP`. Each encodes an operator ruling; each is mutation-tested.
- Do not "fix" the 3,992 abstained cessation windows by closing them anyway. The two dates
  genuinely disagree (annual filing vs operational cessation) and an inverted window makes
  filers vanish from asOf reads silently. This is measured, not a hunch.
- Do not ingest anything from a `fabric/` directory anywhere, ever (CostQuest license).
- Do not run `git stash` (shared across worktrees), do not push to main, do not delete
  branches.
- If apps.fcc.gov or SEC starts returning errors, STOP the run and note it — do not lower
  the pacing intervals or rotate user agents. The pacing constants are commitments, not
  suggestions.
