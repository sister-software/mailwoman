# FIRST_PASS handoff — execution plan for the post-benchmark lanes

Companion to `FIRST_PASS.md` (read that first — it is the evidence base). This file is the
work plan: six lanes, each with its goal, starting points, verification bar, and explicit
prohibitions. Lanes 1–4 are independent and can run in any order; lane 5 is serialized
infra; lane 6 depends on 4 and 5.

Ground rules that bind every lane (from AGENTS.md — read it in full before touching code):

- **D-rule**: no default-on mechanism ships with a known regression vs the shipped model on
  any tier-1 locale (en-us, fr-fr, de-de, en-gb). Fix, per-locale-gate, or opt-in.
- **Model-first**: decode-time rules are soft priors, never hard gates. No case-keyed
  mechanisms (lowercase is the user register).
- **Rebuild, never patch**: databases are sealed readonly artifacts. A bad row means the
  build is rerun, not the artifact edited.
- **Measure before claiming**: every "before/after" needs the probe run in the PR body,
  with numbers. Reasoned-to claims have a documented failure history here.
- **Verify against the branch truth**: `yarn compile && yarn lint && yarn test` (scoped is
  fine, compile must be whole-repo clean — vitest is not tsc). Compiled CLI:
  `node mailwoman/out/cli.js`.
- Open PRs; do NOT merge to main. The operator merges.

---

## Lane 1 — NZ country-scope leakage (diagnosis first, then fix)

**The finding:** the benchmark passed `--locale en-NZ` (the `neural-weights-en-nz` overlay
exists and loaded), yet 22 of 57 NZ rooftop rows resolved ≥10,000 km away — "Auckland
Central" → Queensland, "Hillsborough" → California, "Stanmore Bay" → Stanmore QLD. The
locale hint is NOT gating the resolver's candidate scope.

**This is a diagnosis lane. Do not write a fix before the trace exists.**

1. Reproduce 3 receipt rows through the compiled CLI:
   `node mailwoman/out/cli.js geocode --format json --locale en-NZ -- '22 Customs Street East, Auckland Central'`
   (also en-nz-001 Stanmore Bay, en-nz-006 Hillsborough — full inputs in
   `/mnt/playpen/mailwoman-data/pelias-rig/logs/benchmark-results.jsonl`).
2. Trace where country scope should enter: the locale-gate stage's `LocaleHint`, the
   resolver's country constraint (`resolver/resolve.ts`, span-rescore's candidate
   filters), and the candidate backend's country columns. Find the specific point where an
   NZ hint should narrow candidates and does not.
3. Relevant known state (do not rediscover): the NZ locale arc was FALSIFIED as a data
   problem (#1175) — the real blocker was dead-tag resurrection; the en-nz overlay ships
   NO postcode binary (no WOF NZ postcode shard exists), so the anchor channel is off for
   NZ. Check whether the country channel (`country_ambiguous_scale` era mechanisms) reads
   anything from the locale hint at resolve time.
4. Deliverable: a written root-cause (file:line) + the minimal fix shape + before/after on
   the 22 scattered rows, THEN the fix PR if the fix is decode/resolve-side. If the root
   cause is model-side (the encoder never learned an NZ country prior), STOP and write
   that up instead — that becomes a training-batch item, not a patch.

**Verification bar:** the 22 scattered NZ rows re-scored; tier-1 locales byte-identical
(probe board + hard-slice board). **Prohibited:** hard country filters (soft prior only);
touching the model; "fixing" by special-casing NZ names.

## Lane 2 — en-au weights overlay (packaging)

**The finding:** AU rows ran under en-US default (no overlay exists). 8 WA-state rows
misrouted to US homonyms ("WA" read as Washington State).

1. Clone the overlay structure from a sibling (`neural-weights-en-nz` is the nearest
   shape: overlay with no postcode bin). **AGENTS.md pitfall applies verbatim: the
   overlay `link-dev-weights.ts` is a copy-paste template — rewrite the docstring for AU,
   not just the paths.** If you find yourself cloning a third sibling, extract the shared
   machinery first (freshness guard, md5-sidecar compare, force-link, index spawn).
2. Data available: OA `au/countrywide.csv` (used by the rig); GNAF exists on the data
   root but is derived/non-official schema — OA is the sanctioned source. The overlay
   needs at minimum the locale wiring so `--locale en-AU` resolves and the country scope
   constrains; postcode bin and pair-index are optional follow-ups (note their absence in
   the model card explicitly, like en-nz does).
3. Codex: check `codex/` for an AU module (state abbreviations NSW/VIC/QLD/WA/SA/TAS/ACT/NT
   — "WA" collision with US-WA is exactly what the codex disambiguation is for). If no AU
   codex slice exists, that's part of this lane.
4. Register the overlay everywhere the fr-fr dedup pattern touches: `release.config.json`
   locales (only when release wiring is ready — coordinate with operator), publish.yml
   preflight lists, root `workspaces` array, AGENTS.md table.

**Verification bar:** the 8 WA rows re-scored with `--locale en-AU`; en-us unchanged.
**Prohibited:** shipping without the model-card absence notes; adding to the release list
without operator sign-off.

## Lane 3 — extract the CLI JSON fix (small, do first)

**The finding:** Ink 80-col pipe-wraps `--format json` output under spawn, corrupting the
JSON. Fixed during the benchmark with `writeRawStdout` in 5 commands + a DB-gated
regression test — **currently UNCOMMITTED changes in the main worktree** (files:
`mailwoman/cli-kit/index.ts`, `mailwoman/commands/{autocomplete,geocode,parse,poi,reverse}.tsx`,
`mailwoman/commands/geocode.test.ts`).

1. Review the diff (`git diff`), confirm the 8/8 tests still pass, commit on a fresh
   branch cut from origin/main (`fix/cli-json-pipe-wrap`), PR with the defect story:
   any scripting consumer piping `--format json` got wrapped/corrupt JSON at 80 cols.
2. The benchmark ran AFTER this fix — note in the PR that benchmark reproducibility
   depends on it landing.

**Verification bar:** `echo` the geocode JSON through a pipe and `python3 -m json.tool` it
in the test. **Prohibited:** bundling anything else into this PR.

## Lane 4 — data hygiene: ocean anchor + panel defects

Two small data items, one discipline:

- **de-de-013 "Zethau 168, 09619 Mulda"** → mailwoman answered (18.45, 82.72), an ocean
  point off India. Find which artifact carries the bad anchor (postcode-de path?
  admin-global anchor? candidate row?). Diagnose with the resolver trace, then REBUILD the
  artifact via its build command — never edit the DB. If the root cause is a build-input
  defect, fix the input and rebuild.
- **3 panel truth defects**: `en-gb-049` (Warwick), `en-gb-051` (Epping), `fr-fr-046`
  (COMER parís.méxico — likely not a valid address row at all; decide keep-with-corrected
  -truth vs mark-invalid, and record the decision). Corrected coordinates MUST come from
  the geocode-oracle (Google/Census clients in `geocode-oracle/`) or source registers —
  **never from mailwoman's own resolver** (circularity poisons the instrument). Stamp
  source + retrieval date. Panel becomes `panel-v2.jsonl` with a new sha256 — the v1 hash
  is frozen in the benchmark record; never overwrite v1.
  - Operator note: These are all real addresses.
    - Epping, UK: https://maps.app.goo.gl/EmxNjxwVmb2whiL78
    - Warwick, UK: https://maps.app.goo.gl/nM4WfVwd9Nh6sjHd7
    - COMER parís.méxico, 96 Rue d'Hauteville, 75010 Paris, France: https://maps.app.goo.gl/Ebx9bPEeHeQ856FF8

**Verification bar:** rebuilt artifact re-answers de-de-013 sanely; panel-v2 hash recorded.
**Prohibited:** hand-editing sealed DBs or panel-v1.

## Lane 5 — Nominatim retry, then Photon (infra, serialized)

The first Nominatim import died: osm2pgsql exit 1 after ~3h (memory pressure — 12 GB
Nominatim beside the ~7 GB Pelias runtime stack; swap was fully used at start).

1. Free memory first: `podman stop pelias_api pelias_interpolation pelias_libpostal`
   (keep `pelias_elasticsearch` if RAM allows; it holds the frozen index — do NOT delete
   any Pelias container/volume; the arm must stay re-startable for the five-arm score).
2. Drop the Nominatim container's `mem_limit` to 8g in
   `/mnt/playpen/mailwoman-data/pelias-rig/nominatim/docker-compose.yml`, wipe the
   half-written Postgres data dir (`data/nominatim/postgres/` — it is scratch from the
   failed import) and the flatnode file, then re-run per
   `/mnt/playpen/mailwoman-data/pelias-rig/nominatim/IMPORT-NOTES.md`. All the traps
   already hit (network name, port 8081, osmium shim, userns, local.php chown) are
   documented in the compose comments and OPERATOR-NOTES — read both before starting.
3. Health: `curl 'http://localhost:8081/search?q=Berlin&format=json'`, then the §3 probes.
4. Photon after Nominatim: index exports FROM the Nominatim Postgres (standard photon
   export path). Pin the image digest; record in image-digests.txt.
5. Append every action to `/mnt/playpen/mailwoman-data/pelias-rig/logs/OPERATOR-NOTES.md`
   with timestamps.

**Verification bar:** Nominatim §3 probes recorded; import wall-times in the ledger.
**Prohibited:** running the import beside the full Pelias stack; floating tags; deleting
Pelias data.

## Lane 6 — five-arm re-score (after 4 + 5)

Re-run the locked §4 protocol over panel-v2 with all available arms (mailwoman, Pelias,
Nominatim, Photon, hosted geocode.earth same-day with headers captured). The scorer from
the first pass is at `/tmp/benchmark-scorer.mjs` — move it into the repo
(`pelias-rig/` project dir or `mailwoman/dev-tools/`) so it stops living in /tmp, and keep
its determinism check (run twice, cmp clean).

Additions the first pass earned:

- Report the OA-circularity sensitivity: Pelias rooftop rates with and without the
  truth-in-index rows (62 in v1; recount for v2).
- Same raw string to every arm, round-robin one order, hosted responses cached with
  timestamps + version headers.
- Strata never blended; TOST ±5 pp equivalence per locale and pooled; bootstrap seed
  20260807, 1000 resamples.

**Prohibited:** renegotiating any §4 clause mid-run; dropping or relabeling rows after
scores exist (Google flags for review only).

---

## Sequencing recommendation

Lane 3 (an hour, unblocks reproducibility) → lanes 1+2+4 in parallel → lane 5 whenever the
host is free (it's wall-clock, not attention) → lane 6 last. Lane 1's diagnosis may end at
"model-side, needs a training batch" — that is a VALID terminal state for the lane; write
it up and stop rather than forcing a decode-side patch.

---

## Consult record — DeepSeek briefing (2026-08-08, session `019fde56-361c-7cd2-866f-af9c64e371ad`)

Three turns run before handoff. DeepSeek restated the plan correctly (lane 3 timeboxed
first; 1+2+4 parallel; 5 only with real memory headroom; 6 as the frozen gate) and named
the right failure modes unprompted (premature "model-side" verdict; instrument poisoning;
re-scoring against a moving target).

**Lane-1 diagnostic tree (agreed):**

1. Node 1 — dump pre-scoring candidate rows for one failing query under `--locale en-NZ`
   vs en-US. Byte-identical candidate sets ⇒ hint never reaches the lookup (wiring).
2. Node 2 — BIO dump. Mislabeled spans / dead-tag reappearance ⇒ model-side ⇒ STOP, write
   up for the training batch.
3. Node 3 — the span-rescore tell: if the rescore tier does a fresh global lookup that
   bypasses locale-gated candidates, the hint reaches the first pass but not the tier that
   decides these queries. NOTE: the #1546 alias-recall fix made span-rescore
   population-first over exactMatch candidates — that mechanism shape matches
   Hillsborough→CA exactly. Check whether the 22 scattered rows route through span-rescore.

**Cheapest falsifier (run before writing anything):** one candidate-dump on "Hillsborough"
under en-NZ. US/CA rows present ⇒ hint not gating; NZ-gated rows but foreign winner ⇒ weak
prior or parse defect.

**Pre-registered predictions (calibration record — score these after, do not treat as
gates):**

- NZ hypothesis: LocaleHint never reaches candidate scoring; en-NZ and en-US dumps
  byte-identical; winner comes from a locale-blind population-first exactMatch (likely
  span-rescore). Kill condition: NZ-gated candidates with a foreign winner.
- en-nz @25km after lanes 1+2: ~98% point estimate; below 90% ⇒ a second
  admin-centroid-distance problem exists.

**Reporting contract (accepted):** every lane end reports lane + status
(success/terminal-stop/blocked) + evidence (commands, dumps, hashes) + decision + next
action. Stop-and-wait triggers: model-side diagnosis; corrections lacking an external
oracle; any row relabel after scores exist; a default-on change that can't prove tier-1
non-regression; any bend to the locked protocol; no isolated memory headroom for the
Nominatim retry.
