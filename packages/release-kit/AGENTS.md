# AGENTS.md — `@mailwoman/release-kit`

Scope notes for release operations. The repo-wide rules live in the root `AGENTS.md`; this file
covers the release pipeline's failure modes, and it exists because each one below cost a real
investigation to establish.

Local: `yarn release`. CI: GitHub Actions → `publish` workflow → manual dispatch. See `RELEASING.md` for setup + flow. The notes below cover the gotchas that have bitten this pipeline before — read before touching `packages/release-kit/lib/weights/copy-weights.ts`, `packages/release-kit/lib/pack/publish/workspace.ts`, or `.release-it.json`. Every release step CI runs is `yarn mwops release <operation>` over `@mailwoman/release-kit`'s registry (`packages/release-kit/lib/registry.ts`); `yarn mwops` lists the operations with their declared effect, and the two `external-write` operations (`publish-workspace`, `bless-package`) take a `--plan <file>` written by `mwops release plan --json` and refuse a dirty or moved HEAD or a changed digest. release-it's per-workspace `publishCommand` hook cannot supply a plan, so it passes `--allow-unplanned`, which logs the unverified publish.

## The weights workspaces have moving binaries

The `neural-weights-<locale>` workspaces ship binary artifacts (`model.onnx`, `tokenizer.model`) that are **not** committed to git. Multiple pieces cooperate to get those files in place — be careful when changing any of them:

- `<workspace>/scripts/link-dev-weights.ts` — materializes the artifacts from `$MAILWOMAN_DATA_ROOT/...` into the **data-root overlay** (`$MAILWOMAN_DATA_ROOT/weights/<locale>/`) rather than into the tracked workspace — the workspace package stays bare on a dev checkout (writing into it caused the four hazards `packages/release-kit/lib/weights/link-weights-overlay.ts`'s header lists: empty worktrees, `yarn test` mutating tracked dirs, copy-through-symlink, `YN0035` tarballs). `resolveWeights`'s overlay rung is what reads it in local dev; a test asserting the consumer's package-carries-weights state must seed its own scratch overlay instead (`dropin-cold-start.test.ts`, #1733).
- `packages/neural/test/weights.test.ts` — invokes `link-dev-weights.ts` to verify auto-resolve. **Running `yarn test` re-populates the data-root overlay** as a side effect.
- `mwops release copy-weights` (`packages/release-kit/lib/weights/copy-weights.ts`) — invoked by release-it's `before:init` hook. Materializes the real binaries into each workspace. Skipped in CI when `MAILWOMAN_SKIP_WEIGHTS_COPY=1` (the default for the `publish` workflow when `release_weights=false`).
- A character-path family (`charWeights` in `release.config.json`, `packages/neural-weights-cjk`) reads from its OWN Hugging Face directory, `<family>/v<card version>/`, and is verified against its own card: its `model.onnx` shares a basename with the Latin base's and is different bytes, and the bucket is flat by basename. `fetch-hf-weights` plans a family only once its workspace is in the release list; `mailwoman release hf --char-vocab …` stages it (RELEASING.md).
- `mwops release publish-workspace` (`packages/release-kit/lib/pack/publish/workspace.ts`) — invoked per workspace by release-it's hook (with `--allow-unplanned`) and by `publish.yml`'s loop (with `--plan`). Calls `yarn pack -o <tmp>` (translates `workspace:*` → concrete versions) then `npm publish <tmp>` (npm CLI handles npm-side auth, including Trusted Publishing OIDC in CI).

## Pitfall: the overlay `link-dev-weights.ts` is a copy-paste template

Each locale overlay carries its own `scripts/link-dev-weights.ts`, cloned from a sibling. Copying localizes the CODE and leaves the PROSE behind, and nothing catches a docstring that describes the wrong country — the script works. If you add an overlay, rewrite the docstring for the locale you are adding rather than the paths alone. The shared implementation is `materializeDevOverlay` in `@mailwoman/resolver-wof-sqlite/weights-overlay-linker`, so each script is a manifest plus a call (#2035); the one step no manifest expresses, en-gb's card-conditional postcode binary, stays in en-gb's file. Membership in `LEADING_POSTCODE_COUNTRIES` (`packages/neural/lib/placetype-pair-prior.ts`) is earned by a codex postcode shape plus a confound board; a country's absence there is not always a gap, and the file says which absences are deliberate.

## Pitfall: symlinks in the publish tarball

`yarn npm publish` (and `npm publish`) refuse to upload tarballs containing symlinks — the registry returns HTTP 415 (`YN0035: Symbolic link is not allowed`). Two specific traps make this easy to hit:

1. **`fs.copyFile` follows symlinks at the destination.** A naïve `fs.copyFile(SOURCE, dest)` where `dest` is a symlink writes through the symlink — the symlink stays in place. `copy-weights.ts` mitigates this by `unlink`ing each destination first. Any new script that materializes files into these workspaces **must do the same** (or use `cp --remove-destination` / `fs.cp` with equivalent semantics).
2. **Tests re-created symlinks — historically.** `weights.test.ts` calls `link-dev-weights.ts` on every run; while the linkers wrote into the tracked workspaces, any `yarn test` after `copy-weights.ts` re-symlinked `packages/neural-weights-en-us/`. The linkers now write to the data-root overlay instead, which closes that window by construction — but the safety net below stays, because it also covers a hand-made symlink or an old checkout.

To make publish work regardless of repo state, `mwops release publish-workspace` walks the workspace's `package.json` `files` array right before publishing and dereferences any symlinks (`readlink` → `unlink` → `copyFile`). **Do not remove this safety net** — it closes the window between `copy-weights.ts` (one-shot, at `before:init`) and the actual publish.

## Pitfall: provenance attestation needs the CI identity rather than a public repo alone

`mwops release publish-workspace` adds `--provenance` to `npm publish` when `GITHUB_ACTIONS` is set and `MAILWOMAN_NPM_PROVENANCE` is not `0`. Two things decide it and they are easy to conflate. The repo must be public, because a sigstore attestation links to source third parties have to be able to verify — that half is satisfied. The publish must also run on a CI provider npm supports, because the attestation is signed against an OIDC identity: a local `yarn release` passing `--provenance` fails outright, which is why the predicate is `GITHUB_ACTIONS` and not the generic `CI`. Trusted Publishing works either way; only the attestation needs the CI identity. Set `MAILWOMAN_NPM_PROVENANCE=0` to publish without one when sigstore or the registry is down.

## Pitfall: `workspace:*` doesn't survive `npm publish`

`yarn 4`'s `workspace:*` protocol is yarn-specific. `npm publish` ships the literal string and consumers hit `EUNSUPPORTEDPROTOCOL`. `yarn pack` translates `workspace:*` to the concrete sibling version in the tarball. That's why `publish-workspace.ts` does pack-then-publish instead of either tool alone.

## Pitfall: `exports` carries a dev-only `node → .ts` condition — `publishConfig.exports` is INJECTED at pack time, never committed

Every workspace's committed `exports` map is the DEV map only: curated subpaths with a `node` condition first pointing at `.ts` source (plain `node` runs source in the repo). Consumers can never use that condition — Node refuses to type-strip under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) — so `packages/release-kit/lib/pack/pack-workspace.ts` derives `publishConfig.exports` from the dev map at pack time (strip `node → .ts`, `types` first), lets `yarn pack`'s publishConfig substitution write it into the tarball manifest, and restores the workspace file. A guard then refuses to publish if any exports target is missing from the tarball. Do not commit a `publishConfig.exports`; maintain only the dev map. Tarballs ship source `.ts` + `out/` JS + `.d.ts` (the `files` arrays include all three).

## Pitfall: a workspace missing from the release list freezes — silently, and at consumer expense

`.release-it.json`'s workspaces list is the publish set and the bump set. A workspace outside it is not merely unpublished: release-it never rewrites its `version` either, so it holds whatever number it had when it dropped out — in the repo and on npm — while every sibling moves on. Nothing fails; `yarn release` reports success because from its side there was nothing to do. The latent hazard is ordering: `yarn pack` freezes `workspace:*` to whatever the sibling reads AT PACK TIME, so a package packed before a release bump pins a base the overlay is behind.

A `private: true` flag is checkable; membership in a JSON array is not, so check the arithmetic whenever you add or move a workspace:

```bash
node --input-type=module -e "import { readWorkspaceDirectories } from '@mailwoman/core/workspaces'; import r from './.release-it.json' with { type: 'json' }; const w = await readWorkspaceDirectories('.'); console.log(w.filter((x) => !r.plugins['@release-it-plugins/workspaces'].workspaces.includes(x)))"
```

Every name it prints needs a reason you can state. `mwops release scaffold-weights-overlay` registers a new overlay in both lists for exactly this reason — a locale added by hand skips that step.

A new workspace joins SEVEN registers, and only the first one fails loudly. The root `workspaces` array is what `yarn install` reads, so missing it breaks immediately. The others do not: the release list above, or — when the workspace is held out — `SANCTIONED_RELEASE_ABSENCES` in `packages/release-kit/lib/release/stage.ts`, which is where "a reason you can state" stops being prose and starts being data (`checkReleaseListIdentity` refuses an absence that is in neither, and its `publishCount` pin in `packages/release-kit/test/integration/release-stage.test.ts` moves with either edit); both root `tsconfig.json` reference entries — `./packages/<name>` and `./packages/<name>/tsconfig.test.json`; `mwops release smoke-clean-install`'s pack set (`packages/release-kit/lib/release/smoke/clean-install.ts`), which silently skips a workspace it does not name; and, for a brand-new npm name, the `bless-package` first publish before the name may enter the release list at all (an unblessed name fails the whole release at that workspace with a bare `E404`). Skip the tsconfig pair and `tsc -b` never builds the workspace, so `out/` stays empty and every test-project reference to it fails with `TS6305: Output file has not been built from source file` — which reads as a broken test rather than an unregistered project.

## Every published weights workspace carries two generated rights files

`LICENSE.md` and `PROVENANCE.json` are written by `mwops release write-rights-files`
(`packages/release-kit/lib/weights/rights/`) from the workspace's `package.json` and `model-card.json`, and both are
committed. `LICENSE.md` states the terms this repository grants and what the commercial branch does not reach.
`PROVENANCE.json` records each declared artifact with its digest or `unrecorded`, the card's attribution entries with
the license each one names, and the questions the record leaves open.

Editing a model card changes what a package owes and what it can show, and the compiler reads neither file. The
`weights-rights` repository check holds the committed bytes equal to the writer's output and refuses a workspace whose
`files` array omits either name, so a card edit either regenerates them or fails. Adding an overlay means running the
writer and committing what it produces; `scaffold-weights-overlay` does not write them.

A record is retained by being committed. `PROVENANCE.json` carries its package's version, and git
history holds the record every published version shipped with, so what `10.0.0` said survives `10.1.0`
regenerating. That is the retention, and it holds only while nobody rewrites a record for a version
already on npm. A source's terms changing tomorrow moves the next version's record rather than the
description of a release that already went out; a correction to a published release is a new release
with a new record, or a separately documented notice.

The record makes three distinctions on purpose. A package whose card records no attribution reads
`none-recorded-in-this-package`, which states what the card holds rather than that the artifacts have no attributable
inputs. An artifact with no digest reads `unrecorded` rather than verified. And
`attribution_recorded_in_another_package` names the case the single-card layout produced: `pair-index-gb.bin` ships in
`@mailwoman/neural-weights-en-gb`, and the entry attributing it to HM Land Registry Price Paid Data under OGL v3.0 sits
in `@mailwoman/neural-weights-en-us`'s card.

## One pass over the whole rights chain

`mwops release rights-audit` reads the source register, every published weights package's record, and any frozen
training manifest, and prints what the chain from a source's terms to a published tarball establishes and what it
leaves open. It changes nothing and takes no input.

Read it before a release and read the `Unresolved` section first. The report is not a verdict: an empty `Unresolved`
list would mean the pass found nothing it could not read, which is not a statement that an artifact is cleared for a
use. As of 2026-09-21 the list is not empty — no register source is eligible for ingest, no package has a frozen
training manifest, and four attribution entries name no license this reader could find.

The per-check invariants stay where they are. `weights-rights` holds the generated files equal to their writer's
output, `third-party-notices` holds the three notice copies equal, and `rights-chain` holds every rights document to
naming the licensor. This operation composes their inputs into one report; it does not replace them, and a release
still runs `yarn lint`.

## Recovering from a partial release

The runbook is in [`RELEASING.md`](../../RELEASING.md#recovering-from-a-partial-release).
