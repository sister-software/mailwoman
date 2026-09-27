# Lab reproducibility — strategy

The lab holds ~744 GB of built artifacts, and for most of them it has no record of how they were made. This
plan addresses that in four phases. Each phase is useful on its own and changes a measured count.

The plan also absorbs three documents written separately: `scratchpad/config-file-plan.md` (superseded),
`scratchpad/add-a-country-runbook.md` (its two addenda become phases 2 and 3), and
`2026-08-17-dev-weights-resolution-design.md` (phase 0's detailed design).

## The problem, measured

The lab has two symptoms with one cause.

**A fresh checkout cannot run.** A git worktree resolves the weights workspace and finds it empty, because
`model.onnx` and `tokenizer.model` are not in git. `resolveWeights` then throws before it can reach any
fallback. This was observed on 2026-08-17 while building the dev-MCP worktree arm. The setup step that fixes
it is ten copy-pasted scripts totalling 2,001 lines, ranging from 24 to 586 lines each.

**A built artifact cannot say what built it.** Probing every database over 1 MB in the data root:

```
databases probed: 60 ; carrying layer_manifest: 8
```

The eight are `poi.db` and its variants plus four OSM address-point extracts. The gazetteer databases
(`candidate.db`, `admin-global-priority.db`, every postcode extract, timezone, nuts, un-locode, bdc, and
filer) carry no provenance at all.

The interface already exists. `docs/engineering/reference/layer-interface.mdx` specifies `layer_manifest` /
`layer_coverage`, with source, `asOf`, and the meaning-of-zero coverage rule. **It is implemented on 13% of
the built databases.** The design exists, and the rollout is unfinished.

Two smaller facts also shape what "reproducible" can mean:

- A third of the data root (258 GB) is `pelias-rig`, a comparison rig for a geocoder this repo did not
  build. This repo does not need to reproduce it, and any inventory must report it as external rather than
  counting it as debt.
- The live candidate gazetteer is recorded only as a **symlink** (`candidate.db` →
  `candidate-global-2026-08-15-icu.db`, one of about ten builds in that directory). The selection is real
  configuration, but it is stored only in the filesystem.

## The organising idea

This strategy records provenance rather than adding configuration.

A manifest describes what _was_ built. Configuration describes what _should_ be built. Reproduction needs
the first. #1015 showed why the difference matters. `scripts/wof-build-manifest.json` lagged the live
database by 71 Overture and 161 GeoNames countries, and the real recipe had to be reconstructed from the
artifact's synthetic-id ranges. `RELEASING.md` records the fix: the recipe moved into code and is reviewed
like code, and the manifest became a log.

Every artifact this strategy adds must pass one test: **can it be re-derived from the thing it describes?**
A file that can is a log and cannot lag, because a stale entry fails its own check. A file that cannot is a
register, and registers can disagree without any error.

That test is why the layered config file from `scratchpad/config-file-plan.md` is **not** being built. Its
five-layer precedence stack (CLI → env → project → global → defaults) would add four new places to look
when a geocode comes out wrong. The product's tutorial (`ten-minute-trial.mdx`) highlights _"Right country,
right city, and no flag asked for either"_ and tells the reader to **ignore** the one `export` the CLI
prints. `add-a-country-runbook.md` Addendum A argues the objections. When each objection was tested against
the weights case, two of the three held.

## Already shipped (2026-08-17, on `main`)

Later phases depend on these commits.

| Commit      | What                                                                       |
| ----------- | -------------------------------------------------------------------------- |
| `95d54128a` | Seat preference on a coincident same-name duplicate — the `Of` tie         |
| `f3b173392` | dev-MCP: place-id provenance, a `reload` that refuses, a source-change arm |
| `bfd2b5e46` | Phase 0 design                                                             |

Two things from that work carry into this plan. The **worktree arm** (`{kind:"worktree", ref}`, and
`ref: "WORKTREE"` for uncommitted edits) measures any change in this strategy. The empty-worktree failure
blocked it, which is why phase 0 exists. **Place-id provenance** is the pattern the manifests generalise:
an id or an artifact states its own source, so a reader never has to infer one.

## Phase 0 — dev weights resolution — DONE

The full design is `2026-08-17-dev-weights-resolution-design.md`. Phase 0 deletes the third register.

`release.config.json` already carries `weights.model`, `weights.tokenizer`, and a `lineage` string with more
detail than the code comment that duplicates it. `scripts/copy-weights.ts:177` already reads it. The ten
`link-dev-weights.ts` scripts hold a byte-identical copy of the same two paths. The 9.0.0 reduce failed to
update that copy, and phase 0 removes it.

`@mailwoman/neural` gains one rung that probes a data-root overlay laid out with the shipped filenames. The
published package therefore knows a directory convention and never the recipe.

### Decisions taken

The design left three questions open. This section resolves them.

1. **Layout: one per-locale directory, each artifact symlinked to its source.** _(Revised during implementation.
   The original decision was a shared `base/` directory that the per-locale directories linked into.)_

   ```
   $MAILWOMAN_DATA_ROOT/weights/
     en-us/    model.onnx → <data-root>/models/quantized/<model>.onnx, model-card.json, lexicons, fst-en-us.bin, …
     en-gb/    model.onnx → the SAME source file, postcode-gb.bin, pair-index-gb.bin, …
   ```

   A `base/` directory would have held one copy and had every locale link into it. Linking straight to the recipe's
   source also holds one copy (the source itself), with one fewer indirection and no second record of which model
   is in use. `base/` would have provided a self-contained overlay that survives deletion of the training output.
   That benefit does not justify a 40 MB copy while the recipe remains the authority and the writer is idempotent.

   `resolveFromPackageDir` is unchanged either way. It sees an ordinary directory with every artifact present, and
   `existsSync` follows the link. Symlinks are safe _here_ because their publish hazard (`YN0035`, a tarball
   refusing symlinks) applies only to package directories, and no packaging step tars the data root.

2. **`copy-weights.ts` keeps reading the data root directly.** Pointing it at the overlay would make the
   release ship exactly the bytes dev ran. That is useful but outside phase 0. Revisit it at phase 3, when
   artifacts have manifests and the claim can be checked rather than asserted.

3. **A machine that has never trained fails with an explicit error that prints the path it wanted.** The
   recipe gives a file under `$MAILWOMAN_DATA_ROOT/models/`, which exists only because someone trained there.
   Phases 1–3 address that gap. If phase 0 appeared to work on a fresh machine, it would hide the gap this
   strategy exists to close.

**Acceptance**, with status as of 2026-08-17:

| Criterion                                                                 |                                                                                                                                          |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| A worktree of `HEAD` geocodes with no setup step                          | **met** — `source: overlay:en-us`, 13/13 artifact parity, coordinates identical to main                                                  |
| The sibling report distinguishes `package` / `base` / `overlay` / `cache` | **met**                                                                                                                                  |
| `link` is idempotent                                                      | **met**                                                                                                                                  |
| `yarn test` leaves tracked directories untouched                          | **met** — all ten linkers and `buildPairIndexOverlay` write to the overlay; every tracked package stays empty across a full linker sweep |

**Risk handled in phase 0:** only `model` and `tokenizer` throw. The other ~11 siblings degrade to
`undefined` by design. The new rung could therefore replace a thrown error with a checkout that parses
without lexicons, the FST, or the pair index, scores worse, and reports no problem. Sibling reporting ships
with the rung rather than after it.

## Phase 1 — `mw data inventory` — DONE

`mw data inventory` walks the data root read-only. For each artifact it reports size, kind, its manifest if
it has one, and **"no provenance — unreproducible"** where it does not.

This phase is the cheapest and comes second on purpose. It replaces a vague concern with the count
`8 / 60`, gives every later phase a baseline, and shows where the gaps are. It also has to report the two
facts above directly: `pelias-rig` is a third of the disk and external, and `candidate.db` is a symlink
whose target is a real choice.

**Acceptance:** the command lists every artifact, classifies each as provenanced / unprovenanced /
not-ours, and prints one number. Running it twice on an unchanged root prints the same number.

## Phase 2 — `country-plan` — DONE

`add-a-country-runbook.md` Addendum B, generalised past WOF to OpenAddresses and Overture, in the
two-command shape that document recommends: `--plan` (read-only, prerequisites, current source, size,
the exact patch) and `--apply` (clone, patch, build as a job). The irreversible swap stays its own command.

PR #1727 is the precursor and the acceptance test. It fixes `gazetteer inspect sync`: the destination now
has a default, a repository name as destination is refused, an unfiltered sync is refused without `--all`,
and `--countries` and `--dry-run` are added. The PR followed two occurrences of the same failure. The second
occurred 33 minutes after the PR was opened and was measured while running: 144 repositories, 1,657,412 →
1,823,959 files in three seconds, and `yarn lint` broken repo-wide because oxfmt walks the working tree.

Everything phase 2 produces emits a manifest, so the phase 1 number improves as phase 2 runs.

### The check this phase owes

Only comments in `defaults.ts` enforce "one country, one source". `verifyAdmin` tests floors, so duplication
moves every check number in the passing direction and the build ships. The command that moves a country
between sources is the operation that can violate this rule, so the check ships with the command rather
than after it.

A second instance of the same class was measured recently. Three repositories are checked out **twice**,
under both the flat `<root>/<name>` and nested `<root>/<owner>/<name>` layouts, at identical commits.
`ingestWOF` globs both. `spr` is `INSERT OR REPLACE`, so the duplicate ingest is idempotent and harmless
today. Once the copies diverge, the ingested value depends on which copy FastGlob enumerates last. This
phase should deduplicate the repos root and make one layout canonical.

## Phase 3 — manifest retrofit — DONE for the artifacts a geocode reads

Four builders stamp a `layer_manifest` through one shared `stampLayerManifest`. That function also controls
the ordering: it stamps before the seal or before the swap, because a sealed artifact is `0444` and a
swapped one is already live.

| Builder                       | Artifact                   | Notes                                                                   |
| ----------------------------- | -------------------------- | ----------------------------------------------------------------------- |
| `gazetteer build admin`       | `admin-global-priority.db` | license is the conjunction of the folds that contributed                |
| `gazetteer build candidate`   | `candidate-*.db`           | provenance is a chain that records the ancestor rather than its sources |
| `situs interpolation-extract` | `interpolation/*` (52)     | TIGER, public domain                                                    |
| `situs address-points`        | `address-points/*` (53)    | records the dataset allow-list the build applied                        |

Phase 3 also fixed the OSM rooftop builder, whose `build_cmd` recorded a path that the workspace regroup
had moved. Phase 1 found that defect.

**The interface gained a third spine shape.** `SpineKeys` offered `h3`, `wofID` and `addressID`, which
covered the two layer shapes that existed when it was written: a cellular one and an id-joined one.
`address_point` and `street_segment` carry none of the three. They are probed on
`(postcode | locality, street_norm, number)`. A first draft declared `addressID: "address_id"`, a column
that does not exist. Reading the table rather than the schema module caught the mistake. `street` is
additive, and existing layers are unaffected.

**The number does not move until each artifact is rebuilt.** Artifacts are rebuilt, never patched, so the
shipped databases stay unprovenanced and `data inventory` will keep reporting them as such. This is the
intended behavior of the rebuild rule.

### What phase 3 did not cover, and why

The `wof/` family is 79 databases, and four of its sub-families are still unstamped: the 24 `postcode-*`
extracts, the 13 `postalcode-*` WOF ingests, the 2 `wof-polygons`, and assorted one-offs. None is on the
resolution path a geocode takes. The resolver reads `candidate.db`, and the postcode extracts are inputs to
the candidate build rather than databases it reads at query time. They are worth stamping, but the
acceptance criterion did not require them.

## Standing invariants

These rules come from the repo's own documents. They are restated here because every phase can violate one.

1. **Rebuild, never patch.** A built database is a read-only artifact. The sequence is build, verify, swap.
   A failed verify leaves the artifact unsealed, and an unsealed artifact is never swapped in.
2. **A log may be derived, and a register may not lag.** Anything this plan adds must be re-derivable from
   what it describes, or it will repeat #1015.
3. **Absence is reported as absence.** A missing artifact is reported as missing, with what would produce
   it. It never appears as a measured zero.
4. **The recipe is reviewed like code.** Coverage lists stay in `defaults.ts` with the prose that justifies
   them. A bare string in JSON would lose the six lines of measurement behind `IN`.
5. **Measure the claim.** Every number in this document came from a command. Where a phase rests on a claim
   about data or scale, run the one command that determines the result.

## Open, and directly open

- **The seat-preference term's effect is unverified end-to-end.** It moves 3,896 top slots at the ranker.
  Three inverted probes (the term itself, `compareReferential`, and the candidate `ORDER BY`) produced
  no change in pipeline output on four inputs the sweep says should move. A deliberate `throw` confirmed that
  the harness reads the edits. The pipeline therefore decides those answers downstream of candidate
  ordering, at a stage not yet identified. The worktree arm should be used on this first.
- **`ten-minute-trial.mdx` promises zero configuration.** Every phase here must keep that true. For that
  reason, phases 1 and 2 add commands rather than settings.
