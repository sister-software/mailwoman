---
name: mailwoman-release
description: Codifies the mailwoman npm release — a coordinated version bump across every @mailwoman/* workspace (the model included), published only through CI (publish.yml + npm Trusted Publishing/OIDC), never locally. Covers version determination (npm view + git tag first — a code-only release burns the next number), the model-card + release.config prep PR, the Hugging Face weight-staging prerequisite (`mailwoman release hf`), the dry-run-then-real CI dispatch, and md5 verification of the published tarball. The demo repoint is a separate follow-up. Use when promoting a trained model to npm or publishing any npm release ("publish", "release", "ship v…", "promote the model").
---

# Mailwoman Release Skill

The coordinated-publish runbook. `RELEASING.md` is the canonical doc; this skill is the
operational checklist + the landmines that have bitten real releases (v4.13.0 hit five in one release).

## When to use

- Promoting a trained model to npm (the main case — a new `neural-weights-*` bundle).
- Publishing a code-only npm release (no model change — the version still bumps in sync).
- Operator says "publish", "release", "ship vX", "promote the model".

## When not to use

- Updating only the browser demo — that's a separate repoint (see the last section). The npm
  publish does not touch the demo.
- Anything local — **we never publish locally** (see Cardinal Rule 1).

## Cardinal rules (internalize before touching anything)

1. **Always via CI** — `.github/workflows/publish.yml`, dispatched with `gh workflow run`. npm
   Trusted Publishing (OIDC) means no npm token lives anywhere; CI publishes the weights packages
   too. Local `yarn release` is not the path (local `npm whoami` is E401 by design; the `$MAILWOMAN_DATA_ROOT`
   weight source also doesn't exist on the runner). The operator's rule: "We never do it locally."
2. **Full-sync versioning** — every workspace in `.release-it.json` + `neural-weights-*/model-card.json#version`
   - `release.config.json#version` + the demo `releases.json` share one number per release. The
     trained artifact keeps its own identity (`release.config.json#weights`, the card's `model_lineage`);
     the published version is the unified release number.
3. **The model release version is the NEXT UNIFIED number — verify, don't assume.** A _code-only_
   release bumps the packages but not the card (the card version tracks the model). So the card can
   lag the package version (e.g. card 4.11.0 while npm is at 4.12.0). **Run `npm view mailwoman
version` AND `git tag -l 'v4.*'` and take the next number after the LATEST published** rather than card+1.
4. **The CI workflow FETCHES weights from HF** at `en-us/v<cardVersion>/`. A model release has a hard
   prerequisite: stage the weights to HF FIRST (Step 2). A code-only release skips this (the card
   version is unchanged → CI re-fetches the existing model).
5. **Dry-run before real**, and **verify the published tarball's md5** rather than the workspace file (the
   materialized `model.onnx` can be a stale post-dry-run leftover).

---

## Step 0 — determine the version (the landmine that bit v4.13.0)

```bash
npm view mailwoman version            # the LATEST published (e.g. 4.12.0)
git tag -l 'v4.*' | tail              # confirm no gap/collision
npm view mailwoman versions --json | jq 'index("4.13.0")'   # null = your target is FREE
```

A model promotion is a **minor** bump from the latest published. Pick the explicit semver (e.g.
`4.13.0`). Do not trust `--minor` to compute it — see the dispatch note.

## Step 1 — prep PR (model-card + release.config + staged binary)

For a **model release**, on a branch off current `main`:

1. **Stage the int8 BESIDE the canonical** (new filename, never overwrite):
   ```bash
   cp out/v<run>/model.onnx $MAILWOMAN_DATA_ROOT/models/quantized/model-v<run>-step-40000-int8.onnx
   md5sum out/v<run>/model.onnx   # record this — you'll verify it in the published tarball
   ```
2. **`release.config.json`**: `weights.model` → the new filename, `version` → target, `weights.lineage`
   → the new model story + its int8 md5.
3. **`neural-weights-en-us/model-card.json`**: `version` → target, **`files_md5["model.onnx"]` → the
   new int8 md5**, plus reconcile `model_lineage`, `phase`, `notes` (the `requires` ship-config stays
   UNCHANGED unless the channels changed). Validate JSON: `jq -e .version <file>`.

   The card decides the md5 — en-us's `DEFAULT_MODEL_MD5` derives from it, and
   en-gb's linker reads this file to verify its own link. Skip `files_md5` and the en-gb guard fails
   comparing new bytes against the old digest, which reads as a broken link rather than a missed edit.

4. **The dev linkers read the model filename from `release.config.json`.** Run
   `node packages/neural-weights-en-us/scripts/link-dev-weights.ts` and the en-gb equivalent after
   editing the config. en-gb prints `model.onnx digest ok` when its link matches the en-us card's
   `files_md5`. Check `grep -rl "<old model basename>" --exclude-dir=node_modules .` too: a hit outside
   `scratchpad/`, `.worktrees/` and dated records under `docs/records/` is a file that still names the old model.

5. **Point the card's `fisher_artifact` at the new run's Fisher.** The CI weights fetch reads the
   file and sidecar names from this block. A from-scratch run writes `fisher-diag-v1.npz` and
   `fisher-diag-v1.json` into its final checkpoint directory on the Modal volume. Download both, copy
   them to `fisher-diag-v1-model-<target>.{npz,json}`, and set `file`, `sidecar`, `md5` and the
   parameter count in the `$comment`.

6. **A new graph input or output changes the card and every caller.** v7.2.0 added `locale_hint`, so
   the 10.1.0 card gained `address_systems`. The runtime must also work for a caller that builds
   `NeuralAddressClassifier` or calls `runner.infer` without reading the card: `createScorer`, the
   browser loader's warm-up `infer([0])`, the runner tests and the evaluation tools all do. For a new
   input, give the runtime a default it can feed without the card (`locale_hint` takes `-1`, which the
   graph's `Gather` reads as the last, "no hint" row), and add an export test that pins it.

7. **Run the live-pipeline suites against the materialized candidate.** `yarn mwops release copy-weights`
   (Step 2) replaces `packages/neural-weights-en-us/model.onnx`, which the gauntlet harness, the
   conformance suites, the structural-validity test and the confound board load. Until it runs they
   refuse with a `files_md5` mismatch. After it runs, root `yarn test` grades the candidate: a row the
   candidate breaks fails there, and an exemption the candidate repairs fails as stale. Record each
   accepted regression in its suite's exemption list with the parse it produces and an issue reference.

   `weights.tokenizer` / `weights.tokenizerVersion` change only when the tokenizer changed.
   Confirm by md5 rather than by run name: a from-scratch run reuses the shipped tokenizer unless the recipe replaces it, and
   assuming otherwise stages the wrong one into the bundle.

8. The `neural-weights-fr-fr` card version lags by long-standing convention (publish.yml cp's the
   en-us model into fr-fr) — leave it unless the operator says otherwise.
9. Commit the build scripts + the recipe config + `sync_v0XX` for reproducibility. Push, then open
   the PR with `mwdev_pull_request` (the Bash hook refuses `gh pr create`); it requires an issue whose
   task list is complete, created with `mwdev_issue`. Let CI (`test`) go green, then **merge to main**
   (the publish runs off `main`).

For a **code-only release**: skip the card/release.config/HF work entirely — just merge the code PRs;
the version bump happens in the publish dispatch.

## Step 2 — stage weights to HF (MODEL RELEASE ONLY — the CI prerequisite)

The workflow's `yarn mwops release fetch-hf-weights` step pulls every artifact the weights packages
declare from the PUBLIC HF bucket at `en-us/v<cardVersion>/`. Stage them there first, or the real run
fails before publishing. The fetch plan, not this runbook, decides the set, so verify with the fetch
itself rather than trusting a list.

```bash
# Materialize the binaries into the workspaces (reads release.config.json → the new int8):
yarn mwops release copy-weights
md5sum packages/neural-weights-en-us/model.onnx   # MUST equal your Step-1 int8 md5

# Stage (HF_TOKEN from .env). Uploads to en-us/v<target>/ (additive, safe). This is the 10.1.0 set:
# every locale's FST and pair index, three postcode binaries, the street-morphology FST, both
# evidence lexicons and the Fisher pair. --fsts takes LOWERCASE npm basenames. --fst singular is the
# separate demo asset (fst-en-US.bin); omit it unless also repointing the demo.
W=packages/neural-weights
HF_TOKEN=$(grep -E '^HF_TOKEN=' .env | sed 's/^[^=]*=//') \
node packages/mailwoman/out/cli/main.js release hf v<target> \
  --locale en-us \
  --model $W-en-us/model.onnx \
  --tokenizer $W-en-us/tokenizer.model \
  --model-card $W-en-us/model-card.json \
  --fsts $W-en-us/fst-en-us.bin,$W-fr-fr/fst-fr-fr.bin,$W-en-gb/fst-en-gb.bin,$W-de-de/fst-de-de.bin,$W-es-es/fst-es-es.bin,$W-it-it/fst-it-it.bin,$W-en-us/fst-street-morphology.bin \
  --postcodes $W-en-us/postcode-us.bin,$W-fr-fr/postcode-fr.bin,$W-en-gb/postcode-gb.bin \
  --pair-indexes $W-en-us/pair-index-us.bin,$W-fr-fr/pair-index-fr.bin,$W-en-gb/pair-index-gb.bin,$W-en-nz/pair-index-nz.bin,$W-de-de/pair-index-de.bin,$W-en-in/pair-index-in.bin,$W-es-es/pair-index-es.bin,$W-it-it/pair-index-it.bin \
  --gazetteer-lexicon data/gazetteer/anchor-lexicon-v1.json \
  --country-lexicon data/gazetteer/country-surface-lexicon-v1.json \
  --street-type-lexicon $W-en-us/street-type-lexicon-v3.json \
  --locality-surface-lexicon $W-en-us/locality-surface-lexicon-v7.json \
  --fisher <dir>/fisher-diag-v1-model-<target>.npz,<dir>/fisher-diag-v1-model-<target>.json \
  --steps <training steps> \
  --label "v<target> — <one-liner>" --description "<what changed + headline metrics>"
# Do NOT pass --set-default — that repoints the DEMO (Step 5) rather than the npm publish.

# Verify with the CI fetch itself. Exit 0 means every declared artifact resolved; a 404 line names
# each one still missing. Re-run the upload with it added, then fetch again.
yarn mwops release fetch-hf-weights --into <scratch dir>
```

Check that the fetched `packages/neural-weights-en-us/model.onnx` under the scratch dir has the
Step-1 md5 before dispatching.

**Upload the previous release's data files, not the data root's.** `copy-weights` materializes the
FSTs and pair indexes from `$MAILWOMAN_DATA_ROOT`, which may hold a rebuild no release has published:
at 10.1.0 the en-us, fr-fr and en-gb FSTs and every pair index there differed from 9.1.0's. A model
release that uploads them also changes the gazetteer prior without a measurement. Download those files
from `en-us/v<previous card version>/` and pass the downloaded copies to `--fsts` and
`--pair-indexes`. Compare the SHA-256 hashes of the prior files and the staged copies, and record
their filenames and source version. Equal HTTP `content-length` values do not establish equal contents.
A file with a different hash must be an intentional, evaluated change.

## Step 2b — the release metadata surfaces (the prepare dispatch checks them)

`mode=prepare` runs `yarn mwops release verify-metadata`, which stops the dispatch unless three
surfaces name the new model version. Commit all three on main before dispatching:

1. **The eval ledger.** Append the promotion check's run with
   `node packages/mailwoman/out/cli/main.js eval ledger-append --out-dir <promotion out-dir> --model-version <target> --run-id <label>-<yyyymmdd> --model-path "@mailwoman/neural-weights-en-us@<target>" --card packages/neural-weights-en-us/model-card.json`.
   A check that graded FAIL on a floor the operator accepted needs `--operator-exception <metric>`.
2. **The release matrix.** Add a row for `<target>` at the top of "## The matrix" in
   `docs/engineering/releases.mdx`, and move `(current)` to it.
3. **The status page.** Update the `:::info[Verified as of …]` box, the version table and the model
   artifact sizes in `docs/articles/developers/status.mdx`. Change only figures you measured or can
   compute exactly, and say which in the box.

Run `yarn mwops release verify-metadata` locally before dispatching.

## Step 3 — dispatch the CI publish (two-phase, PR-based; dry-run first)

The "Production Integrity" ruleset requires the release commit to land via a PR with a green
`test` check, so the ship is two dispatches around an auto-merging release PR (the direct
release-it push is retired — the GH013 failure mode below states why):

```bash
# Optional preview — shows the bump diff without pushing anything:
gh workflow run publish.yml --ref main -f mode=prepare -f version=<target> -f dry_run=true

# Phase 1 — bump on release/v<target>, open the PR, dispatch Test at the branch, enable auto-merge:
gh workflow run publish.yml --ref main -f mode=prepare -f version=<target>
RID=$(gh run list --workflow=publish.yml --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch $RID --exit-status --interval 15      # must be: completed / success
# Wait for the auto-merge (test green → the PR merges itself; no human click needed):
gh pr view "release/v<target>" --json state -q .state   # until MERGED

# Audit the complete publish tree after the release PR merges:
gh workflow run publish.yml --ref main -f mode=publish -f dry_run=true
gh run watch <dry-run-id> --exit-status --interval 15
# Require success, including every tarball audit. Repeat after any correction.

# Phase 2 — preflight + tag + GitHub release + npm publish of the merged commit on main:
gh workflow run publish.yml --ref main -f mode=publish
gh run watch <rid> --exit-status --interval 15
```

- **Pass the explicit semver** to `-f version=` (e.g. `4.13.0`) — computed increments have
  degraded to a patch before; the explicit number is the safe form everywhere.
- The repo is PUBLIC → provenance attestation works (`publish-workspace.ts` adds `--provenance` when
  `MAILWOMAN_NPM_PROVENANCE=1`; CI sets it). On a private repo npm rejects it (E422) — leave it off.
- **Partial-failure recovery**: `mode=publish` is idempotent (tag/release are create-if-missing;
  workspace publishes ride `--tolerate-republish`) — just re-dispatch it.
- The HF weight fetch + preflight run in **phase 2** (mode=publish), so HF staging must be complete
  before that dispatch; phase 1 needs no binaries.
- A prepare dry run does not audit tarballs. Both dry and real publish runs must complete the full
  preflight before tagging or publication. Follow `RELEASING.md` for accepted uploads that still
  return 404; do not infer upload failure from registry visibility alone.

## Step 4 — verify the ship (the published tarball rather than the workspace)

```bash
for p in mailwoman @mailwoman/core @mailwoman/neural @mailwoman/neural-weights-en-us @mailwoman/neural-weights-fr-fr; do
  echo "$p -> $(npm view $p version)"          # all == <target>
done
git fetch origin main --tags && git tag -l v<target> && git log origin/main -1 --oneline  # release: v<target>

# THE decisive check — the bundled model is the trained artifact rather than a stale one:
cd /tmp && rm -rf vp && mkdir vp && cd vp
npm pack @mailwoman/neural-weights-en-us@<target> >/dev/null 2>&1
tar xzf *.tgz && md5sum package/model.onnx       # MUST equal the Step-1 int8 md5
jq -r .version package/model-card.json           # == <target>
npm view @mailwoman/neural-weights-en-us@<target> --json | jq '.dist.attestations.url'  # provenance present
```

Then fast-forward local main: `git merge --ff-only origin/main`.

## Step 5 — the demo is SEPARATE (do not conflate with the npm ship)

The npm publish leaves the browser demo (mailwoman.ai/demo) on the old model.
`mailwoman release hf` without `--set-default` leaves HF `releases.json` `defaultVersion`
unchanged. To repoint the demo: set HF default (`--set-default` or patch `releases.json`), upload the
model to R2 (`public.mailwoman.ai/mailwoman/en-us/v<target>/`), and bump the demo version constant
in `docs/src/`. Heed the `hasPolygons=false` warning (demo degrades to rectangles/anchor-off if the
R2 side is incomplete). This is its own task — surface it, don't assume it.

## failure mode index (each cost real time on a prior release)

- **Code-only release burns the next number** without bumping the card → `npm view` + `git tag` FIRST.
- **`--minor` → patch** through the yarn wrapper → pass the explicit semver to `-f version=`.
- **CI fetches weights from HF at the card version** → stage to HF before the real run (model releases).
- **Local npm is E401** → CI only; the OIDC path needs no token.
- **The materialized `model.onnx` can read stale** (post-dry-run cleanup) → verify the published tarball.
- **The FST is model-independent** → reuse the prior version's; don't rebuild it for a model bump.
- **Demo ≠ npm** → `--set-default` + R2 + demo constant are a separate repoint.
- **Stage binaries BESIDE the canonical** (new filename); the operator approves the actual swap = the merge + dispatch.
- **Branch rulesets reject direct pushes to main** (the "Production Integrity"
  ruleset — PR + `test` required, bypass = OrganizationAdmin only — rejected the old release-it
  direct push with GH013 AFTER a green dry-run; dry-run doesn't exercise the push). That incident
  produced the current two-phase PR flow (Step 3). If a ruleset change ever blocks the flow again,
  it's an OPERATOR decision — do not loosen a protection rule to ship.
- **Release PRs need their `test` check dispatched explicitly** — GITHUB_TOKEN-created PRs never
  trigger `on: pull_request` (anti-recursion), so mode=prepare runs `gh workflow run test.yml --ref
release/v<target>` itself. If an auto-merge ever hangs with "expected — waiting", check whether
  that dispatch failed and re-run it; do not merge past the check.
