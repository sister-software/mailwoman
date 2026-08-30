# Lab reproducibility — strategy

The lab holds ~744 GB of built artifacts and cannot say how most of them were made. This is the plan to
change that, in four phases, each independently useful and each leaving a number that moves.

It also absorbs three documents written separately: `scratchpad/config-file-plan.md` (superseded),
`scratchpad/add-a-country-runbook.md` (its two addenda become phases 2 and 3), and
`2026-08-17-dev-weights-resolution-design.md` (phase 0's detailed design).

## The problem, measured

Two symptoms, one cause.

**A fresh checkout cannot run.** A git worktree resolves the weights workspace and finds it empty —
`model.onnx` and `tokenizer.model` are not in git — so `resolveWeights` throws before it can reach any
fallback. Measured 2026-08-17 while building the dev-MCP worktree arm. The setup step that fixes it is ten
copy-pasted scripts totalling 2,001 lines, ranging 24 to 586.

**A built artifact cannot say what built it.** Probing every database over 1 MB in the data root:

```
databases probed: 60 ; carrying layer_manifest: 8
```

The eight are `poi.db` and its variants plus four OSM address-point shards. The gazetteer itself —
`candidate.db`, `admin-global-priority.db`, every postcode shard, timezone, nuts, un-locode, bdc, filer —
carries no provenance at all.

The contract already exists. `docs/engineering/reference/layer-contract.mdx` specifies `layer_manifest` /
`layer_coverage`, with source, `asOf`, and the meaning-of-zero coverage rule. **It is implemented on 13% of
the built databases.** That is the whole finding: this is not a missing design, it is an unfinished rollout.

Two smaller facts worth carrying, because they shape what "reproducible" can mean:

- A third of the data root — 258 GB — is `pelias-rig`, a comparison rig for a geocoder this repo did not
  build. It is not ours to reproduce, and any inventory must say so rather than counting it as debt.
- Which candidate gazetteer is live is expressed as a **symlink** (`candidate.db` →
  `candidate-global-2026-08-15-icu.db`, one of about ten builds in that directory) and nowhere else. The
  selection is real configuration held in a filesystem detail.

## The organising idea

**Provenance, not configuration.**

A manifest describes what _was_ built. Configuration describes what _should_ be built. Reproduction needs
the first. This distinction is not stylistic — it is the lesson of #1015, where
`scripts/wof-build-manifest.json` lagged the live database by 71 Overture and 161 GeoNames countries and the
real recipe had to be reconstructed from the artifact's synthetic-id ranges. `RELEASING.md` records the fix:
the recipe moved INTO code, reviewed like code, and the manifest was demoted to a LOG.

So the test for every artifact this strategy adds is: **can it be re-derived from the thing it describes?**
A file that can is a log and cannot lag — a stale entry fails its own check. A file that cannot is a
register, and registers disagree silently.

That test is why the layered config file from `scratchpad/config-file-plan.md` is **not** being built. Its
own five-layer precedence stack (CLI → env → project → global → defaults) would add four new places to look
when a geocode comes out wrong, in a product whose tutorial's proudest line is _"Right country, right city,
and no flag asked for either"_ and which tells the reader to **ignore** the one `export` the CLI prints
(`ten-minute-trial.mdx`). The objections are argued out in `add-a-country-runbook.md` Addendum A; tested
objection by objection against the weights case, two of three hold decisively.

## Already shipped (2026-08-17, on `main`)

Recorded because later phases depend on them.

| Commit      | What                                                                       |
| ----------- | -------------------------------------------------------------------------- |
| `95d54128a` | Seat preference on a coincident same-name duplicate — the `Of` tie         |
| `f3b173392` | dev-MCP: place-id provenance, a `reload` that refuses, a source-change arm |
| `bfd2b5e46` | Phase 0 design                                                             |

Two things from that work carry into this plan. The **worktree arm** (`{kind:"worktree", ref}`, and
`ref: "WORKTREE"` for uncommitted edits) is the instrument for measuring any change in this strategy, and it
is the reason phase 0 exists — it was blocked by exactly the empty-worktree failure. And **place-id
provenance** is the pattern the manifests generalise: an id or an artifact that states its own source, so a
reader never has to infer one.

## Phase 0 — dev weights resolution — DONE

Full design: `2026-08-17-dev-weights-resolution-design.md`. Summary: delete the third register.

`release.config.json` already carries `weights.model`, `weights.tokenizer`, and a `lineage` string richer
than the code comment duplicating it; `scripts/copy-weights.ts:177` already reads it. The ten
`link-dev-weights.ts` scripts hold a byte-identical copy of the same two paths. That duplicate is the leg the
9.0.0 cut dropped, and it goes.

`@mailwoman/neural` gains one rung that probes a data-root overlay laid out with the shipped filenames, so
the published package learns a directory convention and never the recipe.

### Decisions taken

The design left three questions open. Resolving them here.

1. **Layout: one per-locale directory, each artifact symlinked to its source.** _(Revised during implementation —
   the original decision was a shared `base/` directory that the per-locale directories linked into.)_

   ```
   $MAILWOMAN_DATA_ROOT/weights/
     en-us/    model.onnx → <data-root>/models/quantized/<model>.onnx, model-card.json, lexicons, fst-en-us.bin, …
     en-gb/    model.onnx → the SAME source file, postcode-gb.bin, pair-index-gb.bin, …
   ```

   A `base/` directory would have held one copy and had every locale link into it. Linking straight to the recipe's
   source holds one copy too — the source itself — with one fewer indirection and no second place for "which model is
   this" to be answered. What `base/` would have bought is a self-contained overlay that survives the training output
   being deleted; that is not worth a 40 MB copy while the recipe remains the authority and the writer is idempotent.

   `resolveFromPackageDir` is untouched either way: it sees an ordinary directory with every artifact present, and
   `existsSync` follows the link. Symlinks are safe _here_ precisely because the publish hazard they cause (`YN0035`,
   a tarball refusing symlinks) applies to package directories, and nothing tars the data root.

2. **`copy-weights.ts` keeps reading the data root directly.** Pointing it at the overlay would mean the
   release ships exactly the bytes dev ran, which is attractive and is not phase 0's job. Revisit at phase 3,
   when artifacts have manifests and the claim can be checked rather than asserted.

3. **A machine that has never trained fails loudly, naming the path it wanted.** The recipe names a file
   under `$MAILWOMAN_DATA_ROOT/models/`, which exists only because someone trained there. Phase 0 does not
   pretend otherwise — that gap is the subject of phases 1–3, and a phase 0 that appeared to work on a fresh
   box would hide the very thing this strategy is for.

**Acceptance**, with status as of 2026-08-17:

| Criterion                                                                 |                                                                                                                                          |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| A worktree of `HEAD` geocodes with no setup step                          | **met** — `source: overlay:en-us`, 13/13 artifact parity, coordinates identical to main                                                  |
| The sibling report distinguishes `package` / `base` / `overlay` / `cache` | **met**                                                                                                                                  |
| `link` is idempotent                                                      | **met**                                                                                                                                  |
| `yarn test` leaves tracked directories untouched                          | **met** — all ten linkers and `buildPairIndexOverlay` write to the overlay; every tracked package stays empty across a full linker sweep |

**Risk carried, not deferred:** only `model` and `tokenizer` throw. The other ~11 siblings degrade to
`undefined` by design, so the new rung could turn a loud failure into a quiet one — a checkout that parses
with no lexicons, no FST, no pair index, scoring worse and saying nothing. Sibling reporting ships with the
rung, not after it.

## Phase 1 — `mw data inventory` — DONE

Read-only walk of the data root. Per artifact: size, kind, its manifest if it has one, and
**"no provenance — unreproducible"** where it does not.

This is deliberately the cheapest phase and deliberately second. It turns an anxiety into `8 / 60`, gives
every later phase a scoreboard, and tells us where the real gaps are instead of us guessing. It also has to
report the two facts above honestly: that `pelias-rig` is a third of the disk and not ours, and that
`candidate.db` is a symlink whose target is a real choice.

**Acceptance:** the command names every artifact, classifies each as provenanced / unprovenanced /
not-ours, and prints one number. Running it twice on an unchanged root prints the same number.

## Phase 2 — `country-plan` — DONE

`add-a-country-runbook.md` Addendum B, generalised past WOF to OpenAddresses and Overture, in the
two-command shape that document recommends: `--plan` (read-only, prerequisites, current source, size,
the exact patch) and `--apply` (clone, patch, build as a job). The irreversible swap stays its own command.

PR #1727 is the precursor and the acceptance test. It fixes `gazetteer inspect sync` — destination defaulted,
repository-name-as-destination refused, unfiltered sync refused without `--all`, `--countries` added,
`--dry-run` added — after the same trap fired twice, the second time 33 minutes after the PR was opened and
measured while running: 144 repositories, 1,657,412 → 1,823,959 files in three seconds, and `yarn lint`
broken repo-wide because oxfmt walks the working tree.

Everything phase 2 produces emits a manifest, so the phase 1 number improves by construction.

### The gate this phase owes

"One country, one source" is currently held by comments in `defaults.ts`; `verifyAdmin` tests floors, so
duplication moves every gate number in the passing direction and the build ships. The command that MOVES a
country between sources is exactly the thing that can violate the invariant, so the gate lands with the
command, not after it.

A second, newly measured instance of the same class: three repositories are currently checked out **twice**,
under both the flat `<root>/<name>` and nested `<root>/<owner>/<name>` layouts, at identical commits. `ingestWOF`
globs both; `spr` is `INSERT OR REPLACE`, so it is idempotent and harmless today. It stops being harmless the
moment the copies diverge, at which point the ingested value is last-writer-wins over FastGlob's enumeration
order. Deduplicating the repos root and naming one layout canonical belongs here.

## Phase 3 — manifest retrofit — DONE for the artifacts a geocode reads

Four builders stamp a `layer_manifest`, through one shared `stampLayerManifest` that also owns the ordering
(before the seal, or before the swap — a sealed artifact is `0444` and a swapped one is already live):

| Builder                     | Artifact                   | Notes                                                                  |
| --------------------------- | -------------------------- | ---------------------------------------------------------------------- |
| `gazetteer build admin`     | `admin-global-priority.db` | licence is a CONJUNCTION of the folds that actually contributed        |
| `gazetteer build candidate` | `candidate-*.db`           | provenance is a CHAIN — names its ancestor, not the ancestor's sources |
| `situs interpolation-shard` | `interpolation/*` (52)     | TIGER, public domain                                                   |
| `situs address-points`      | `address-points/*` (53)    | records the dataset allow-list the build applied                       |

Plus a fix to the OSM rooftop builder, whose `build_cmd` recorded a path the workspace regroup moved — the
defect phase 1 surfaced.

**The contract gained a third spine shape.** `SpineKeys` offered `h3`, `wofID` and `addressID` — the two
layer shapes that existed when it was written, a cellular one and an id-joined one. `address_point` and
`street_segment` carry none of the three; they are probed on `(postcode | locality, street_norm, number)`.
A first draft declared `addressID: "address_id"`, a column that does not exist, caught by reading the table
rather than the schema module. `street` is additive; existing layers are unaffected.

**The number does not move until each artifact is rebuilt.** Artifacts are rebuilt, never patched, so the
shipped databases stay unprovenanced and `data inventory` will keep reporting them as such. That is the
discipline working, not a gap.

### What phase 3 did NOT cover, and why

The `wof/` family is 79 databases and four of its sub-families are still unstamped: the 24 `postcode-*`
shards, the 13 `postalcode-*` WOF ingests, the 2 `wof-polygons`, and assorted one-offs. None is on the
resolution path a geocode takes — the resolver reads `candidate.db`, and the postcode shards are INPUTS to
the candidate build rather than things it reads at query time. They are worth stamping and they are not
what the acceptance criterion asked for.

## Standing invariants

Carried from the repo's own documents, restated because every phase can violate one.

1. **Rebuild, never patch.** A built database is a read-only artifact. Build, verify, swap; a failed verify
   leaves the artifact unsealed and an unsealed artifact is never swapped in.
2. **A log may be derived; a register may not lag.** Anything this plan adds must be re-derivable from what
   it describes, or it becomes the next #1015.
3. **Absence is reported as absence.** A missing artifact says so and says what would produce it. It never
   reads as a measured zero.
4. **The recipe is reviewed like code.** Coverage lists stay in `defaults.ts` with the prose that earned
   them; a bare string in JSON loses the six lines of measurement behind `IN`.
5. **Measure the claim.** Every number in this document came from a command. Where a phase rests on a claim
   about data or scale, it spends the one command that determines the result.

## Open, and honestly open

- **The seat-preference term's reach is unverified end-to-end.** It moves 3,896 top slots at the ranker.
  Three inverted probes — the term itself, `compareReferential`, and the candidate `ORDER BY` — changed
  nothing in pipeline output on four inputs the sweep says move, while a deliberate `throw` confirmed the
  harness reads the edits. So the pipeline decides those answers downstream of candidate ordering, and where
  is not yet known. The worktree arm is the instrument; this is the first thing to point it at.
- **`ten-minute-trial.mdx` promises zero configuration.** Every phase here must leave that true. Phase 1 and
  2 add commands, not settings, for that reason.
