# Dev weights resolution — design

Phase 0 of the lab-reproducibility sequence. Makes a fresh checkout — worktree, clone, or subprocess arm —
resolve model weights without a setup step, and collapses the dev recipe onto the file the release path
already trusts.

## The problem, measured

`resolveWeights` (`packages/neural/lib/weights.ts:243`) walks four rungs: explicit paths → an explicit
`cacheRoot` → the installed package directory → the user cache at `~/.cache/mailwoman/weights`. Rung three
throws when the package resolves but its binaries are missing, and the throw is deliberate — its comment
calls it "the metadata-only dev-checkout trap".

In a git worktree the workspace package always resolves and is always empty, because `model.onnx` and
`tokenizer.model` are not in git. So rung three fires and rungs beyond it are unreachable. The failure reads
as a broken environment:

```
CommandError: geocode requires the neural weights. Install @mailwoman/neural-weights-en-us
```

That was measured while building the dev-MCP worktree arm (2026-08-17): a child process in a fresh worktree
could not build an engine until the farm stopped re-pointing the weights workspaces.

### Which registers hold "which model is the dev model"

Three, and the en-us link script's own docstring names all three plus the incident:

> Bump this path, model-card.json `files_md5`, and release.config.json `weights.model` in LOCKSTEP on each
> ship — the 9.0.0 cut moved only release.config, which left this default and the card's md5 record on the
> prior base for a full release cycle.

| Register                                                                | Holds                                                                                                    | Read by                                                                            |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `release.config.json` `weights.model` / `weights.tokenizer`             | the data-root-relative path, plus `lineage` prose carrying both md5s, the gate verdict and receipt paths | `scripts/copy-weights.ts:177` — the release path                                   |
| `<package>/model-card.json` `files_md5`                                 | the digest of the shipped bytes                                                                          | `link-dev-weights.ts`, re-verified against the published tarball at release step 4 |
| `packages/neural-weights-*/scripts/link-dev-weights.ts` `DEFAULT_MODEL` | the same path again, as a hardcoded constant                                                             | the dev path only                                                                  |

The third is a duplicate of the first, byte-identical today, in ten scripts totalling **2,001 lines** and
ranging from 24 (`it-it`) to 586 (`en-gb`). AGENTS.md predicts this shape ("the template is a defect
generator"); the 9.0.0 lockstep miss is the prediction landing.

### Why not a config file

Considered and rejected. `scratchpad/add-a-country-runbook.md` Addendum A argues that a JSON recipe is "the
same shape as the thing that lagged" in #1015, that it adds a register, and that JSON cannot carry the
reasoning a code comment does. The first two objections are decisive against a NEW file. The third turns out
not to apply: `release.config.json` already carries richer prose in `lineage` than the code comment it would
replace.

So this design adds no file and no configuration system. It deletes the third register and points the dev
path at the first.

## Design

### 1. `release.config.json` becomes the single dev recipe

Delete `DEFAULT_MODEL` / `DEFAULT_TOKENIZER` from all ten `link-dev-weights.ts` scripts. Read
`weights.model` / `weights.tokenizer` from `release.config.json`, resolved against the data root, exactly as
`copy-weights.ts` does.

`MAILWOMAN_DEV_MODEL` / `MAILWOMAN_DEV_TOKENIZER` keep their current meaning as per-invocation overrides
that relax the digest assertion, matching `MAILWOMAN_PUBLISH_MODEL` on the release side.

The lockstep instruction loses a leg and moves to `release.config.json`'s `$comment`, where the remaining
two legs are both visible.

### 2. A data-root weights overlay, and one new rung

Populate `$MAILWOMAN_DATA_ROOT/weights/<locale>/` with the shipped filenames — the same layout
`resolveFromPackageDir` already reads. It resolves ~13 sibling artifacts (model, tokenizer, model-card, CRF
and semi-CRF transitions, anchor lookup, four lexicons, pair index, per-locale FST, street-morphology FST),
every one as `resolve(packageDir, "<fixed-name>")`. That function does not change.

The new rung sits between the installed-package rung and the user cache: when the package directory resolves
but has no binaries, probe the overlay before throwing.

`@mailwoman/neural` ships to npm, so it learns the CONVENTION and never the recipe. It knows the directory
layout; it does not know `release.config.json` exists. The dev link command, which is monorepo-only, reads
the recipe and writes the overlay.

The overlay is a DERIVED artifact, not a register: rebuilt from the recipe, verified against the card's
`files_md5`. By the runbook's own criterion — `wof-build-manifest.json` is a LOG because it can be
re-derived — it cannot lag in the #1015 sense. A stale entry fails its digest check rather than being
believed.

Consequence worth stating: nothing symlinks into a tracked package directory any more. That is the shared
cause of three known hazards — `yarn test` mutating tracked directories as a side effect of
`weights.test.ts`, the `fs.copyFile`-through-a-symlink trap in `copy-weights.ts`, and the publish tarball
symlink refusal (`YN0035`). **The `publish-workspace.ts` dereference net stays.** Its cause is gone, not its
value; AGENTS.md says do not remove it, and a net whose hazard is merely unlikely is still the net.

### 3. Sibling reporting, because the rung trades a loud failure for a quiet one

Only `model` and `tokenizer` throw. The other ~11 siblings resolve `existsSync → undefined` and are
absence-tolerant by design. So a checkout that finds those two now parses successfully with no lexicons, no
FST and no pair index — scoring worse, and silently.

This is the risk the rung introduces and it must not ship unreported.

`ResolvedWeights` gains a per-artifact resolution report: which siblings resolved, and from which directory
(`package`, `base`, `overlay`, `cache`). `mailwoman doctor` renders it, so "which half do I have" — the
question `ten-minute-trial.mdx` teaches the reader to ask — answers at the artifact level rather than at the
package level.

### 4. The `files_md5` gate

Measured across the ten weights workspaces: only `en-us` carries a populated `files_md5`. Every overlay's is
empty and `base-latn` has no card at all.

That is defensible for `model.onnx` and `tokenizer.model` — overlays share the base byte-for-byte via
`mailwoman.baseWeights` and have no digest of their own — but it means the digest assertion covers one of
ten packages, and it covers nothing an overlay actually ships: `postcode-gb.bin`, `pair-index-de.bin`, the
lexicons, the per-locale FSTs.

The link command refuses to link an overlay-owned artifact that has no recorded digest, rather than linking
it unchecked. This is the runbook's closing move — "promote the warning to a gate" — applied here.

## What is NOT in scope

- The layered config file from `scratchpad/config-file-plan.md`. Superseded; see "Why not a config file".
- Any change to `resolveFromPackageDir`'s sibling list or resolution order.
- Removing the `publish-workspace.ts` symlink dereference net.
- Phases 1–3 of the reproducibility sequence (`mw data inventory`, `mw data pull country`, manifest
  retrofit). Each gets its own spec.

## Testing

Unit, against a temporary data root and a fake package directory:

- package with binaries → resolves from the package; overlay never probed
- package empty, overlay populated → resolves from the overlay, `source` says so
- package empty, overlay empty, user cache populated → falls through to the cache (existing behaviour holds)
- package empty, nothing anywhere → throws, naming the package dir, the overlay and the cache
- overlay model present, tokenizer absent → throws rather than half-resolving
- sibling report distinguishes a sibling resolved from `package` versus `overlay` versus absent
- overlay artifact whose digest is absent from `files_md5` → link refuses
- overlay artifact whose digest MISMATCHES `files_md5` → link refuses, naming both digests
- `MAILWOMAN_DEV_MODEL` set → digest assertion relaxed, and the relaxation is reported

Integration:

- a git worktree of HEAD resolves weights with no setup step (the case that prompted this)
- `link` is idempotent: a second run changes nothing and says so

Regression:

- `packages/neural/test/weights.test.ts` currently invokes `link-dev-weights.ts` and re-creates symlinks in
  `packages/neural-weights-en-us/` as a side effect. After this change it must leave tracked directories
  untouched; assert that explicitly rather than assuming it.

## Open questions

1. **Does the overlay hold one locale directory per locale, or one shared directory plus per-locale
   overlays?** Every locale shares `model.onnx` and `tokenizer.model` byte-for-byte, so ten per-locale
   directories would hold ten copies of ~40 MB. A shared `base/` plus per-locale directories mirrors the
   `mailwoman.baseWeights` relationship the resolver already implements. Leaning shared; wants a decision
   before implementation because it is the on-disk layout.
2. **Does `copy-weights.ts` read the overlay or the data root directly?** It reads
   `release.config.json` → data root today and works. Leaving it alone is the smaller change; pointing it at
   the overlay would mean the release ships exactly the bytes dev ran. Leaning leave-alone for phase 0, and
   revisit when phase 3 gives artifacts manifests.
3. **What populates the overlay on a machine that has never trained?** The recipe names a path under
   `$MAILWOMAN_DATA_ROOT/models/`, which exists only because someone trained there. A fresh lab has no such
   file. This is exactly the reproducibility gap phases 1–3 address, so phase 0 should FAIL LOUDLY with the
   path it wanted rather than appear to work.
