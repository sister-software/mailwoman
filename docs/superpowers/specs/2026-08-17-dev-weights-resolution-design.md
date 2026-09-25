# Dev weights resolution — design

This design is phase 0 of the lab-reproducibility sequence. It lets a fresh checkout (worktree, clone, or
subprocess arm) resolve model weights without a setup step. It also moves the dev recipe onto the file the
release path already reads.

## The problem, measured

`resolveWeights` (`packages/neural/lib/weights.ts:243`) checks four rungs in order: explicit paths, an
explicit `cacheRoot`, the installed package directory, and the user cache at `~/.cache/mailwoman/weights`.
Rung three throws when the package resolves but its binaries are missing. The throw is deliberate, and its
comment calls it "the metadata-only dev-checkout trap".

In a git worktree the workspace package always resolves and is always empty, because `model.onnx` and
`tokenizer.model` are not in git. Rung three therefore throws, and the resolver never reaches rung four. The
error looks like a broken environment:

```
CommandError: geocode requires the neural weights. Install @mailwoman/neural-weights-en-us
```

This error appeared while building the dev-MCP worktree arm (2026-08-17). A child process in a fresh
worktree could not build an engine until the farm stopped re-pointing the weights workspaces.

### Which registers hold "which model is the dev model"

Three registers hold it. The en-us link script's docstring lists all three and describes the incident:

> Bump this path, model-card.json `files_md5`, and release.config.json `weights.model` in LOCKSTEP on each
> ship — the 9.0.0 reduce moved only release.config, which left this default and the card's md5 record on the
> prior base for a full release cycle.

| Register                                                                | Holds                                                                                                     | Read by                                                                            |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `release.config.json` `weights.model` / `weights.tokenizer`             | the data-root-relative path, plus `lineage` prose carrying both md5s, the check verdict and receipt paths | `scripts/copy-weights.ts:177` — the release path                                   |
| `<package>/model-card.json` `files_md5`                                 | the digest of the shipped bytes                                                                           | `link-dev-weights.ts`, re-verified against the published tarball at release step 4 |
| `packages/neural-weights-*/scripts/link-dev-weights.ts` `DEFAULT_MODEL` | the same path again, as a hardcoded constant                                                              | the dev path only                                                                  |

The third register duplicates the first and is byte-identical to it today. It lives in ten scripts that total
**2,001 lines**, ranging from 24 (`it-it`) to 586 (`en-gb`). AGENTS.md warns about this pattern ("the
template is a defect generator"), and the 9.0.0 lockstep miss is an instance of it.

### Why not a config file

A config file was considered and rejected. `scratchpad/add-a-country-runbook.md` Addendum A argues three
points: a JSON recipe is "the same shape as the thing that lagged" in #1015, it adds a register, and JSON
cannot carry the reasoning a code comment does. The first two objections rule out a new file. The third does
not apply here, because `release.config.json` already carries more prose in `lineage` than the code comment
it would replace.

So this design adds no file and no configuration system. It deletes the third register and points the dev
path at the first.

## Design

### 1. `release.config.json` becomes the single dev recipe

Delete `DEFAULT_MODEL` / `DEFAULT_TOKENIZER` from all ten `link-dev-weights.ts` scripts. Read
`weights.model` / `weights.tokenizer` from `release.config.json`, resolved against the data root, exactly as
`copy-weights.ts` does.

`MAILWOMAN_DEV_MODEL` / `MAILWOMAN_DEV_TOKENIZER` keep their current meaning as per-invocation overrides
that relax the digest assertion, matching `MAILWOMAN_PUBLISH_MODEL` on the release side.

The lockstep instruction then covers two registers instead of three. It moves to `release.config.json`'s
`$comment`, where both remaining registers are visible.

### 2. A data-root weights overlay, and one new rung

Populate `$MAILWOMAN_DATA_ROOT/weights/<locale>/` with the shipped filenames, using the same layout
`resolveFromPackageDir` already reads. It resolves ~13 sibling artifacts (model, tokenizer, model-card, CRF
and semi-CRF transitions, anchor lookup, four lexicons, pair index, per-locale FST, street-morphology FST),
every one as `resolve(packageDir, "<fixed-name>")`. That function does not change.

The new rung sits between the installed-package rung and the user cache. When the package directory
resolves but has no binaries, the resolver probes the overlay before throwing.

`@mailwoman/neural` ships to npm, so it knows the directory convention and never the recipe. It knows the
directory layout but does not know that `release.config.json` exists. The dev link command, which exists only
in the monorepo, reads the recipe and writes the overlay.

The overlay is a derived artifact rather than a register. It is rebuilt from the recipe and verified against
the card's `files_md5`. The runbook treats `wof-build-manifest.json` as a log because it can be re-derived.
By that criterion the overlay cannot lag in the #1015 sense. A stale entry fails its digest check instead of
being used.

With this change, nothing symlinks into a tracked package directory any more. Those symlinks are the shared
cause of three known hazards: `yarn test` mutating tracked directories as a side effect of
`weights.test.ts`, the `fs.copyFile`-through-a-symlink trap in `copy-weights.ts`, and the publish tarball
symlink refusal (`YN0035`). **The `publish-workspace.ts` dereference net stays.** Its usual cause is removed,
but AGENTS.md says not to remove it, and it still dereferences any symlink that reappears.

### 3. Sibling reporting, because the rung trades a loud failure for a quiet one

Only `model` and `tokenizer` throw. The other ~11 siblings resolve `existsSync → undefined` and tolerate
absence by design. A checkout that finds those two files therefore parses successfully without lexicons,
the FST, or the pair index. It scores worse and reports nothing.

The rung introduces this risk, so it must not ship without a report.

`ResolvedWeights` gains a per-artifact resolution report: which siblings resolved, and from which directory
(`package`, `base`, `overlay`, `cache`). `mailwoman doctor` renders it. The question
`ten-minute-trial.mdx` teaches the reader to ask, "which half do I have", then gets an answer per artifact
rather than per package.

### 4. The `files_md5` check

Across the ten weights workspaces, only `en-us` carries a populated `files_md5`. Every overlay's
`files_md5` is empty, and `base-latn` has no card at all.

The empty digests are defensible for `model.onnx` and `tokenizer.model`, because overlays share the base
byte-for-byte via `mailwoman.baseWeights` and have no digest of their own. They also mean the digest
assertion covers one of ten packages and none of the files an overlay ships: `postcode-gb.bin`,
`pair-index-de.bin`, the lexicons, and the per-locale FSTs.

The link command refuses to link an overlay-owned artifact that has no recorded digest, rather than linking
it unchecked. This applies the runbook's closing recommendation, "promote the warning to a check".

## What is not in scope

- The layered config file from `scratchpad/config-file-plan.md`. This design supersedes it (see "Why not a
  config file").
- Any change to `resolveFromPackageDir`'s sibling list or resolution order.
- Removing the `publish-workspace.ts` symlink dereference net.
- Phases 1–3 of the reproducibility sequence (`mw data inventory`, `mw data pull country`, manifest
  retrofit). Each gets its own spec.

## Testing

Unit, against a temporary data root and a fake package directory:

- package with binaries → resolves from the package; overlay never probed
- package empty, overlay populated → resolves from the overlay, `source` says so
- package empty, overlay empty, user cache populated → falls through to the cache (the lookup still uses the cache)
- package empty, nothing anywhere → throws and lists the package dir, the overlay and the cache
- overlay model present, tokenizer absent → throws rather than half-resolving
- sibling report distinguishes a sibling resolved from `package` versus `overlay` versus absent
- overlay artifact whose digest is absent from `files_md5` → link refuses
- overlay artifact whose digest does not match `files_md5` → link refuses and prints both digests
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
   `mailwoman.baseWeights` relationship the resolver already implements. The current preference is a shared
   directory. This needs a decision before implementation because it fixes the on-disk layout.
2. **Does `copy-weights.ts` read the overlay or the data root directly?** Today it reads the data root
   through `release.config.json`, and that works. Leaving it alone is the smaller change. Pointing it at the
   overlay would make the release ship exactly the bytes dev ran. The current preference is to leave it
   alone for phase 0 and revisit when phase 3 gives artifacts manifests.
3. **What populates the overlay on a machine that has never trained?** The recipe gives a path under
   `$MAILWOMAN_DATA_ROOT/models/`, which exists only because someone trained there. A fresh lab has no such
   file. Phases 1–3 address this reproducibility gap, so phase 0 should fail with an explicit error that
   prints the path it wanted rather than appear to work.
