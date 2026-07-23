---
name: mailwoman-release
description: Codifies the mailwoman npm release — a coordinated version bump across ALL @mailwoman/* workspaces (the model included), published ENTIRELY via CI (publish.yml + npm Trusted Publishing/OIDC), never locally. Covers version determination (npm view + git tag FIRST — a code-only release burns the next number), the model-card + release.config prep PR, the Hugging Face weight-staging prerequisite (`mailwoman release hf`), the dry-run-then-real CI dispatch, and PUBLISHED-tarball md5 verification. The demo repoint is a SEPARATE follow-up. Use when promoting a trained model to npm or cutting any npm release ("publish", "release", "ship v…", "promote the model").
---

# Mailwoman Release Skill

The coordinated-publish runbook. `RELEASING.md` is the canonical doc; this skill is the
operational checklist + the landmines that have bitten real releases (v4.13.0 hit five in one cut).

## When to use

- Promoting a trained model to npm (the main case — a new `neural-weights-*` bundle).
- Cutting a code-only npm release (no model change — the version still bumps in sync).
- Operator says "publish", "release", "ship vX", "promote the model".

## When NOT to use

- Updating ONLY the browser demo — that's a separate repoint (see the last section). The npm
  publish does NOT touch the demo.
- Anything local — **we never publish locally** (see Cardinal Rule 1).

## Cardinal rules (internalize before touching anything)

1. **ALWAYS via CI** — `.github/workflows/publish.yml`, dispatched with `gh workflow run`. npm
   Trusted Publishing (OIDC) means no npm token lives anywhere; CI publishes the weights packages
   too. Local `yarn release` is NOT the path (local `npm whoami` is E401 by design; the `/mnt/playpen`
   weight source also doesn't exist on the runner). The operator's rule: "We never do it locally."
2. **Full-sync versioning** — every workspace in `.release-it.json` + `neural-weights-*/model-card.json#version`
   - `release.config.json#version` + the demo `releases.json` share ONE number per release. The
     trained artifact keeps its own identity (`release.config.json#weights`, the card's `model_lineage`);
     the published version is just the unified release number.
3. **The model release version is the NEXT UNIFIED number — verify, don't assume.** A _code-only_
   release bumps the packages but NOT the card (the card version tracks the MODEL). So the card can
   lag the package version (e.g. card 4.11.0 while npm is at 4.12.0). **Run `npm view mailwoman
version` AND `git tag -l 'v4.*'` and take the next number after the LATEST published**, not card+1.
4. **The CI workflow FETCHES weights from HF** at `en-us/v<cardVersion>/`. A model release has a hard
   prerequisite: stage the weights to HF FIRST (Step 2). A code-only release skips this (the card
   version is unchanged → CI re-fetches the existing model).
5. **Dry-run before real**, and **verify the PUBLISHED tarball's md5**, not the workspace file (the
   materialized `model.onnx` can be a stale post-dry-run leftover).

---

## Step 0 — determine the version (the landmine that bit v4.13.0)

```bash
npm view mailwoman version            # the LATEST published (e.g. 4.12.0)
git tag -l 'v4.*' | tail              # confirm no gap/collision
npm view mailwoman versions --json | jq 'index("4.13.0")'   # null = your target is FREE
```

A model promotion is a **minor** bump from the latest published. Pick the explicit semver (e.g.
`4.13.0`). Do NOT trust `--minor` to compute it — see the dispatch note.

## Step 1 — prep PR (model-card + release.config + staged binary)

For a **model release**, on a branch off current `main`:

1. **Stage the int8 BESIDE the canonical** (new filename, never overwrite):
   ```bash
   cp out/v<run>/model.onnx /mnt/playpen/mailwoman-data/models/quantized/model-v<run>-step-40000-int8.onnx
   md5sum out/v<run>/model.onnx   # record this — you'll verify it in the published tarball
   ```
2. **`release.config.json`**: `weights.model` → the new filename, `version` → target, `weights.lineage`
   → the new model story + its int8 md5.
3. **`neural-weights-en-us/model-card.json`**: `version` → target, plus reconcile `model_lineage`,
   `phase`, `notes` (the `requires` ship-config stays UNCHANGED unless the channels changed). Validate
   JSON: `jq -e .version <file>`.
4. The `neural-weights-fr-fr` card version lags by long-standing convention (publish.yml cp's the
   en-us model into fr-fr) — leave it unless the operator says otherwise.
5. Commit the build scripts + the recipe config + `sync_v0XX` for reproducibility. Push, open PR,
   let CI (`test`) go green, then **merge to main** (the publish runs off `main`).

For a **code-only release**: skip the card/release.config/HF work entirely — just merge the code PRs;
the version bump happens in the publish dispatch.

## Step 2 — stage weights to HF (MODEL RELEASE ONLY — the CI prerequisite)

The workflow's "Fetch weight binaries from Hugging Face" step pulls `model.onnx`, `tokenizer.model`,
`postcode-us.bin`, `postcode-fr.bin` from the PUBLIC HF bucket at `en-us/v<cardVersion>/`. Stage them
there first, or the real run fails the `[ -s "$f" ]` guard.

```bash
# Materialize the binaries into the workspaces (reads release.config.json → the new int8;
# BUILDS postcode-us.bin / postcode-fr.bin):
node scripts/copy-weights.ts
md5sum neural-weights-en-us/model.onnx   # MUST equal your Step-1 int8 md5 (a stale leftover reads wrong)

# The FST gazetteer is MODEL-INDEPENDENT — reuse the prior release's:
curl -fSL "https://huggingface.co/buckets/sister-software/mailwoman/resolve/en-us/v<prev>/fst-en-US.bin" \
  -o /tmp/fst-en-US.bin

# Stage (HF_TOKEN from .env; hf CLI authed as the org). Uploads to en-us/v<target>/ (additive, safe):
HF_TOKEN=$(grep -E '^HF_TOKEN=' .env | cut -d= -f2-) \
node mailwoman/out/cli.js release hf v<target> \
  --locale en-us \
  --model neural-weights-en-us/model.onnx \
  --tokenizer neural-weights-en-us/tokenizer.model \
  --model-card neural-weights-en-us/model-card.json \
  --fst /tmp/fst-en-US.bin \
  --postcodes neural-weights-en-us/postcode-us.bin,neural-weights-fr-fr/postcode-fr.bin \
  --gazetteer-lexicon data/gazetteer/anchor-lexicon-v1.json \
  --label "v<target> — <one-liner>" --description "<what changed + headline metrics>"
# Do NOT pass --set-default — that repoints the DEMO (Step 5), not the npm publish.
```

The script self-verifies each artifact is reachable via HTTPS. Confirm `en-us/v<target>/model.onnx`
returns HTTP 200 before dispatching.

## Step 3 — dispatch the CI publish (two-phase, PR-based; dry-run first)

The "Production Integrity" ruleset requires the release commit to land via a PR with a green
`test` check, so the ship is TWO dispatches around an auto-merging release PR (the direct
release-it push was retired 2026-07-23 after GH013 — see the gotcha below):

```bash
# Optional preview — shows the bump diff without pushing anything:
gh workflow run publish.yml --ref main -f mode=prepare -f version=<target> -f dry_run=true

# Phase 1 — bump on release/v<target>, open the PR, dispatch Test at the branch, enable auto-merge:
gh workflow run publish.yml --ref main -f mode=prepare -f version=<target>
RID=$(gh run list --workflow=publish.yml --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch $RID --exit-status --interval 15      # must be: completed / success
# Wait for the auto-merge (test green → the PR merges itself; no human click needed):
gh pr view "release/v<target>" --json state -q .state   # until MERGED

# Phase 2 — tag + GitHub release + npm publish of the merged commit on main:
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
  before THAT dispatch; phase 1 needs no binaries.

## Step 4 — verify the ship (the PUBLISHED tarball, not the workspace)

```bash
for p in mailwoman @mailwoman/core @mailwoman/neural @mailwoman/neural-weights-en-us @mailwoman/neural-weights-fr-fr; do
  echo "$p -> $(npm view $p version)"          # all == <target>
done
git fetch origin main --tags && git tag -l v<target> && git log origin/main -1 --oneline  # release: v<target>

# THE decisive check — the bundled model is the trained artifact, not a stale one:
cd /tmp && rm -rf vp && mkdir vp && cd vp
npm pack @mailwoman/neural-weights-en-us@<target> >/dev/null 2>&1
tar xzf *.tgz && md5sum package/model.onnx       # MUST equal the Step-1 int8 md5
jq -r .version package/model-card.json           # == <target>
npm view @mailwoman/neural-weights-en-us@<target> --json | jq '.dist.attestations.url'  # provenance present
```

Then fast-forward local main: `git merge --ff-only origin/main`.

## Step 5 — the demo is SEPARATE (do not conflate with the npm ship)

The npm publish leaves the browser demo (mailwoman.sister.software/demo) on the OLD model.
`mailwoman release hf` without `--set-default` leaves HF `releases.json` `defaultVersion`
unchanged. To repoint the demo: set HF default (`--set-default` or patch `releases.json`), upload the
model to R2 (`public.sister.software/mailwoman/en-us/v<target>/`), and bump the demo version constant
in `docs/src/`. Heed the `hasPolygons=false` warning (demo degrades to rectangles/anchor-off if the
R2 side is incomplete). This is its own task — surface it, don't assume it.

## Gotcha index (each cost real time on a prior cut)

- **Code-only release burns the next number** without bumping the card → `npm view` + `git tag` FIRST.
- **`--minor` → patch** through the yarn wrapper → pass the explicit semver to `-f version=`.
- **CI fetches weights from HF at the card version** → stage to HF before the real run (model releases).
- **Local npm is E401** → CI only; the OIDC path needs no token.
- **The materialized `model.onnx` can read stale** (post-dry-run cleanup) → verify the PUBLISHED tarball.
- **The FST is model-independent** → reuse the prior version's; don't rebuild it for a model bump.
- **Demo ≠ npm** → `--set-default` + R2 + demo constant are a separate repoint.
- **Stage binaries BESIDE the canonical** (new filename); the operator gates the actual swap = the merge + dispatch.
- **Branch rulesets reject direct pushes to main** (v7.6.0, 2026-07-23: the "Production Integrity"
  ruleset — PR + `test` required, bypass = OrganizationAdmin only — rejected the old release-it
  direct push with GH013 AFTER a green dry-run; dry-run doesn't exercise the push). That incident
  produced the current two-phase PR flow (Step 3). If a ruleset change ever blocks the flow again,
  it's an OPERATOR decision — do not loosen a protection rule to ship.
- **Release PRs need their `test` check dispatched explicitly** — GITHUB_TOKEN-created PRs never
  trigger `on: pull_request` (anti-recursion), so mode=prepare runs `gh workflow run test.yml --ref
release/v<target>` itself. If an auto-merge ever hangs with "expected — waiting", check whether
  that dispatch failed and re-run it; do NOT merge past the check.
