# AGENTS.md — `release-kit`

Scope notes for release operations. The repo-wide rules live in the root `AGENTS.md`; this file
covers the release pipeline's failure modes, and it exists because each one below cost a real
investigation to establish.

Local: `yarn release`. CI: GitHub Actions → `publish` workflow → manual dispatch. See `RELEASING.md` for setup + flow. The notes below cover the gotchas that have bitten this pipeline before — read before touching `lib/release-kit/weights/copy-weights.ts`, `lib/release-kit/pack/publish/workspace.ts`, or `.release-it.json`. Every release step CI runs is `yarn mwops release <operation>` over `release-kit`'s registry (`lib/release-kit/registry.ts`); `yarn mwops` lists the operations with their declared effect, and the two `external-write` operations (`publish-workspace`, `bless-package`) take a `--plan <file>` written by `mwops release plan --json` and refuse a dirty or moved HEAD or a changed digest. release-it's per-workspace `publishCommand` hook cannot supply a plan, so it passes `--allow-unplanned`, which logs the unverified publish.

## The weights workspaces have moving binaries

The `neural-weights-<locale>` workspaces ship binary artifacts (`model.onnx`, `tokenizer.model`) that are **not** committed to git. Multiple pieces cooperate to get those files in place — be careful when changing any of them:

- `<workspace>/scripts/link-dev-weights.ts` — materializes the artifacts from `$MAILWOMAN_DATA_ROOT/...` into the **data-root overlay** (`$MAILWOMAN_DATA_ROOT/weights/<locale>/`) rather than into the tracked workspace — the workspace package stays bare on a dev checkout (writing into it caused the four hazards `lib/release-kit/weights/link-weights-overlay.ts`'s header lists: empty worktrees, `yarn test` mutating tracked dirs, copy-through-symlink, `YN0035` tarballs). `resolveWeights`'s overlay rung is what reads it in local dev. A test asserting the consumer's state in which the package contains the weights must seed its own scratch overlay instead (`dropin-cold-start.test.ts`, #1733).
- `packages/neural/test/weights.test.ts` — invokes `link-dev-weights.ts` to verify auto-resolve. **A `yarn test` run re-populates the data-root overlay** as a side effect.
- `mwops release copy-weights` (`lib/release-kit/weights/copy-weights.ts`) — invoked by release-it's `before:init` hook. Materializes the real binaries into each workspace from this machine's data root. The `publish` workflow has no data root: its publish step sets `MAILWOMAN_SKIP_WEIGHTS_COPY=1` and relies on the earlier `mwops release fetch-hf-weights` step. That step downloads each weights package's untracked `files` from the Hugging Face bucket and checks them against the model card md5s.
- A character-path family (`charWeights` in `release.config.json`, `packages/neural-weights-cjk`) reads from its OWN Hugging Face directory, `<family>/v<card version>/`, and is verified against its own card: its `model.onnx` shares a basename with the Latin base's and is different bytes, and the bucket is flat by basename. `fetch-hf-weights` plans a family only once its workspace is in the release list; `mailwoman release hf --char-vocab …` stages it (RELEASING.md).
- `mwops release publish-workspace` (`lib/release-kit/pack/publish/workspace.ts`) — invoked per workspace by release-it's hook (with `--allow-unplanned`) and by `publish.yml`'s loop (with `--plan`). Calls `yarn pack -o <tmp>` (translates `workspace:*` → concrete versions) then `npm publish <tmp>` (npm CLI handles npm-side auth, including Trusted Publishing OIDC in CI).

## Pitfall: the overlay `link-dev-weights.ts` is a copy-paste template

Each locale overlay has its own `scripts/link-dev-weights.ts`, cloned from a sibling. A copy localizes the code and leaves the prose behind, and the working script does not reveal a docstring that describes the wrong country. If you add an overlay, rewrite the docstring for the locale you are adding as well as the paths. The shared implementation is `materializeDevOverlay` in `@mailwoman/resolver-wof-sqlite/weights-overlay-linker`, so each script is a manifest plus a call (#2035). The one step no manifest expresses, en-gb's card-conditional postcode binary, stays in en-gb's file. Membership in `LEADING_POSTCODE_COUNTRIES` (`packages/neural/lib/placetype-pair-prior.ts`) is earned by a codex postcode shape plus a confound board. A country's absence there is not always a gap, and the file's comments state which absences are deliberate.

## Pitfall: symlinks in the publish tarball

`yarn npm publish` (and `npm publish`) refuse to upload tarballs containing symlinks — the registry returns HTTP 415 (`YN0035: Symbolic link is not allowed`). Two specific traps make this easy to hit:

1. **`fs.copyFile` follows symlinks at the destination.** A naïve `fs.copyFile(SOURCE, dest)` where `dest` is a symlink writes through the symlink. The symlink stays in place. `copy-weights.ts` mitigates this by `unlink`ing each destination first. Any new script that materializes files into these workspaces **must do the same** (or use `cp --remove-destination` / `fs.cp` with equivalent semantics).
2. **Tests re-created symlinks — historically.** `weights.test.ts` calls `link-dev-weights.ts` on every run. While the linkers wrote into the tracked workspaces, any `yarn test` after `copy-weights.ts` re-symlinked `packages/neural-weights-en-us/`. The linkers now write to the data-root overlay instead, and that change closes the window by construction — but the safety net below stays, because it also covers a hand-made symlink or an old checkout.

To make publish work regardless of repo state, `mwops release publish-workspace` walks the workspace's `package.json` `files` array right before publishing and dereferences any symlinks (`readlink` → `unlink` → `copyFile`). **Do not remove this safety net** — it closes the window between `copy-weights.ts` (one-shot, at `before:init`) and the actual publish.

## Pitfall: provenance attestation needs the CI identity as well as a public repo

`mwops release publish-workspace` adds `--provenance` to `npm publish` when `GITHUB_ACTIONS` is set and `MAILWOMAN_NPM_PROVENANCE` is not `0`. Two things decide it and they are easy to conflate. The repo must be public, because a sigstore attestation links to source third parties have to be able to verify. The public repository satisfies that requirement. The publish must also run on a CI provider npm supports, because the attestation is signed against an OIDC identity: a local `yarn release` passing `--provenance` fails. For that reason the predicate is `GITHUB_ACTIONS` and not the generic `CI`. Trusted Publishing works either way. Only the attestation needs the CI identity. Set `MAILWOMAN_NPM_PROVENANCE=0` to publish without one when sigstore or the registry is down.

## Pitfall: `workspace:*` doesn't survive `npm publish`

`yarn 4`'s `workspace:*` protocol is yarn-specific. `npm publish` ships the literal string and consumers hit `EUNSUPPORTEDPROTOCOL`. `yarn pack` translates `workspace:*` to the concrete sibling version in the tarball. That's why `publish-workspace.ts` does pack-then-publish instead of using either tool by itself.

## Pitfall: `exports` holds a dev-only `node → .ts` condition — `publishConfig.exports` is INJECTED at pack time, never committed

Every workspace's committed `exports` map is the DEV map only: one `*` pattern per source root, plus `.`, `./package.json` and `./env`, each with a `node` condition first pointing at `.ts` source (plain `node` runs source in the repo). Consumers can never use that condition — Node refuses to type-strip under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) — so `lib/release-kit/pack/pack-workspace.ts` derives `publishConfig.exports` from the dev map at pack time (strip `node → .ts`, `types` first), lets `yarn pack`'s publishConfig substitution write it into the tarball manifest, and restores the workspace file. A guard then refuses to publish if a concrete exports or imports target is missing from the tarball, or if a pattern target matches no shipped file. Do not commit a `publishConfig.exports`; maintain only the dev map. Tarballs ship source `.ts` + `out/` JS + `.d.ts` (the `files` arrays include all three).

## Pitfall: a workspace missing from the release list freezes — silently, and at consumer expense

`.release-it.json`'s workspaces list is the publish set and the bump set. A workspace outside it is not merely unpublished: release-it never rewrites its `version` either, so it holds whatever number it had when it dropped out — in the repo and on npm — while every sibling moves on. `yarn release` reports success because release-it did not select that workspace. The latent hazard is ordering: `yarn pack` freezes `workspace:*` to whatever the sibling reads AT PACK TIME, so a package packed before a release bump pins a base the weights overlay is behind.

A `private: true` flag is checkable. Membership in a JSON array is not, so check the arithmetic whenever you add or move a workspace:

```bash
node --input-type=module -e "import { readWorkspaceDirectories } from '@mailwoman/core/workspaces'; import r from './.release-it.json' with { type: 'json' }; const w = await readWorkspaceDirectories('.'); console.log(w.filter((x) => !r.plugins['@release-it-plugins/workspaces'].workspaces.includes(x)))"
```

Every name it prints needs a reason you can state. `mwops release scaffold-weights-overlay` registers a new overlay in both lists for exactly this reason — a locale added by hand skips that step.

A new workspace joins SIX registers, and only the first one fails loudly. The root `workspaces` array is what `yarn install` reads, so missing it breaks immediately. The others do not: the release list above, or — when the workspace is held out — `SANCTIONED_RELEASE_ABSENCES` in `lib/release-kit/release/stage.ts`, which is where "a reason you can state" stops being prose and starts being data (`checkReleaseListIdentity` refuses an absence that is in neither, and its `publishCount` pin in `lib/release-kit/release-stage.integration.test.ts` moves with either edit); both root `tsconfig.json` reference entries — `./packages/<name>` and `./packages/<name>/tsconfig.test.json`; and, for a brand-new npm name, the `bless-package` first publish before the name may enter the release list at all (an unblessed name fails the whole release at that workspace with a bare `E404`). `mwops release smoke-clean-install` derives its pack set from the release list (`lib/release-kit/release/smoke/clean-install.ts`), so it is not a register of its own. Skip the tsconfig pair and `tsc -b` never builds the workspace, so `out/` stays empty and every test-project reference to it fails with `TS6305: Output file has not been built from source file` — which reads as a broken test rather than an unregistered project.

## Every published weights workspace ships two generated rights files

`LICENSE.md` and `PROVENANCE.json` are written by `mwops release write-rights-files`
(`lib/release-kit/weights/rights/`) from the workspace's `package.json` and `model-card.json`, and both are
committed. `LICENSE.md` states the terms this repository grants and what the commercial branch does not reach.
`PROVENANCE.json` records each declared artifact with its digest or `unrecorded`, the card's attribution entries with
the license each one names, and the questions the record leaves open.

A model-card edit changes what a package owes and what it can show, and the compiler reads neither file. The
`weights-rights` repository check holds the committed bytes equal to the writer's output. It also refuses a workspace
whose `files` array omits either name, so a card edit either regenerates them or fails. A new weights overlay requires a
run of the writer and a commit of what it produces. `scaffold-weights-overlay` does not write them.

A record is retained by being committed. `PROVENANCE.json` records its package's version, and git
history holds the record every published version shipped with, so the `10.0.0` record survives the `10.1.0`
regeneration. That is the retention, and it holds only while no maintainer rewrites a record for a version
already on npm. If a source's terms change after a release, the change moves the next version's record rather than the
description of a release that already went out. A correction to a published release is a new release
with a new record, or a separately documented notice.

The record makes three distinctions on purpose. A package whose card records no attribution reads
`none-recorded-in-this-package`, which states what the card holds rather than that the artifacts have no attributable
inputs. An artifact with no digest reads `unrecorded` rather than verified. And
`attribution_recorded_in_another_package` names the case the single-card layout produced, where an artifact ships in one
package and the entry attributing it sits in another package's card. `pair-index-gb.bin` was that case until its entry
moved into `@mailwoman/neural-weights-en-gb`'s own card.

## One pass over the whole rights chain

`mwops release rights-audit` reads the source register, every published weights package's record, and any frozen
training manifest, and prints what the chain from a source's terms to a published tarball establishes and what it
leaves open. It reads repository records and takes no input.

Read it before a release and read the `Unresolved` section first. An empty `Unresolved`
list would mean the pass read every requested value. Artifact clearance requires a separate decision.
The operation exits non-zero when a graph package's card records a corpus with no frozen training manifest
under `packages/corpus/data/training-manifests/`, and both `publish.yml` jobs run it. An overlay corpus gets
its record from `freeze-overlay-manifest.run.ts`, which reads every parquet file the corpus manifest lists,
because `freezeTrainingManifest` runs only inside `buildCorpus` and counts the adapter rows the build
aligned rather than the rows its files hold. The effective manifest derived from that record carries the
attributions the audited epoch's sources owe, and `write-rights-files` prints them in each `LICENSE.md`;
an overlay repeats its base's.

The per-check invariants stay where they are. `weights-rights` holds the generated files equal to their writer's
output, `third-party-notices` holds the three notice copies equal, and `rights-chain` holds every rights document to
naming the licensor. This operation composes their inputs into one report. It does not replace them, and a release
still runs `yarn lint`.

A corpus's frozen `TRAINING_SOURCES.json` states what the corpus holds rather than what trained a model: overlays
merge after `freezeTrainingManifest`, so the effective manifest
(`packages/corpus/data/training-manifests/<corpus>.effective.json`, `unrecordedSourceStages`) can carry sources the
frozen manifest never names. `PROVENANCE.json`'s `effective_training_sources` reads `null` when a card names no
`training.corpus_version`, and `provenanceRefusals` reports that gap rather than inventing a join. Read the effective
manifest before quoting a model's training sources.

## Partial-release recovery

The runbook is in [`RELEASING.md`](../../RELEASING.md#recovering-from-a-partial-release).
