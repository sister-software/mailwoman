# Releasing

Mailwoman publishes a coordinated set of npm packages: the `mailwoman` CLI plus its full transitive
`@mailwoman/*` runtime closure. `.release-it.json` declares that closure, and the list **must stay in sync with
the dependency graph**. If `mailwoman` (or any published package) gains a new `@mailwoman/*` runtime
dependency, that dependency must join the list. Otherwise the published `mailwoman` will not install, because
npm returns 404 for the dependency. As of v7.0.0 the set is 12 workspaces: `mailwoman` + `@mailwoman/{core,
normalize, query-shape, kind-classifier, locale-hint, phrase-grouper, codex, corpus, neural,
neural-weights-en-us, neural-weights-fr-fr}`. All of them, including the model, publish at one synced version
(see Versioning policy). The core packages are:

| Package                           | Workspace dir           | Notes                                                                               |
| --------------------------------- | ----------------------- | ----------------------------------------------------------------------------------- |
| `mailwoman`                       | `mailwoman/`            | CLI + high-level `AddressParser`                                                    |
| `@mailwoman/core`                 | `core/`                 | tokenization, decoder; ships ~9 MB of libpostal+WOF dictionaries under `core/data/` |
| `@mailwoman/corpus`               | `corpus/`               | BIO-labeled dataset builder                                                         |
| `@mailwoman/neural`               | `neural/`               | SentencePiece tokenizer + ONNX runtime + decoder wiring                             |
| `@mailwoman/neural-weights-en-us` | `neural-weights-en-us/` | trained model bundle (en-us)                                                        |
| `@mailwoman/neural-weights-fr-fr` | `neural-weights-fr-fr/` | trained model bundle (fr-fr)                                                        |

[`release-it`](https://github.com/release-it/release-it) drives the version bump + tag + publish + GitHub release. [`@release-it-plugins/workspaces`](https://github.com/release-it-plugins/workspaces) coordinates the multi-package version bump and per-package `npm publish`.

## One-time setup

1. **npm account with `@mailwoman` org access.** Create the org at <https://www.npmjs.com/org/create> if it does not exist (it is free for public packages). Add yourself as owner.
2. **Local npm auth.** Run `npm login` once per machine. The token is stored in `~/.npmrc`, and release-it picks it up automatically.
3. **GitHub auth.** Run `gh auth login` once. release-it uses the same token through `gh` for the GitHub release step.

## Dry run

> **The local `yarn release` flow is retired for real releases** (2026-07-23). The "Production
> Integrity" ruleset on `main` rejects release-it's direct push (GH013), so real releases go through
> the two-phase CI flow described in "Releasing from CI" below. `yarn release --dry-run` is still
> useful as a local preview of the version bump and the packed files.

Verify the flow without publishing:

```bash
yarn release --dry-run
```

This will:

1. Compile (`yarn compile`). The pre-flight **does not run tests**, because PR CI already ran them. See the
   `before:init` hook in `.release-it.json`.
2. Materialize trained weights into `neural-weights-{en-us,fr-fr}/` through `yarn mwops release copy-weights` (paths from
   `release.config.json`).
3. Show the proposed version bump for each workspace.
4. Stage the tag, GitHub release and npm publishes that a real run would create, without executing them.

Inspect the output. If it looks wrong, fix and re-run.

## Release preflight — pack and audit all 51 tarballs without publishing (#1894)

The v9.2.0 release needed four publish dispatches, because no tool could exercise the release tree the
way CI publishes it without creating a tag or writing to a registry. The preflight does that:

```bash
yarn compile                             # the audit packs compiled out/ trees
yarn release:preflight                   # --source repo (default): weights from this machine's data root
yarn release:preflight --source hf       # weights from the public HF bucket — what CI publishes
```

It stages the tracked tree (`git archive`) into an isolated root and materializes the weights
artifacts there. It then packs and audits every `.release-it.json` workspace through the same
`packWorkspaceForPublish` + `verifyTarball` path that the publish workflow uses, and it collects every
failure in one sweep. It also checks the named-absence identity: the root workspaces minus the release
list must equal the six sanctioned absences by name (see `packages/release-kit/lib/release/stage.ts`).
Add `--keep` or `--staging <dir>` to inspect the tree afterwards. The preflight writes no state to git,
GitHub, npm, R2 or HF, and an interrupted run cannot dirty the checkout.

The two sources differ only in where the bytes come from:

- `--source repo` runs `release.copy-weights` against `$MAILWOMAN_DATA_ROOT`, which is the recipe a local
  `yarn release` uses. Measured 2026-08-25: PASS, 51/51 in 37.4 s.
- `--source hf` runs `release.fetch-hf-weights` against the public bucket, which is the recipe
  `publish.yml` runs and the same call the workflow makes. It needs no credentials. `--version <model-card
version>` overrides the version, which otherwise comes from the base package's `model-card.json`
  exactly as CI reads it.

`--source hf` derives the set of files to materialize instead of reading a list. The set is each
`neural-weights-<locale>` package's `files` array minus what `git ls-files` already reports, which is the
same predicate `verify-tarball.ts` uses to refuse a publish. Each download is checked against the md5s
that the model cards declare. Filenames that no card declares an md5 for are listed in the receipt and
are not counted as verified. The Fisher pair (`fisher_artifact.file` + `.sidecar`) is HEAD-probed and
never fetched, because it stays in the bucket, the runtime never reads it, and npm never ships it.

## Rights audit — what the release publishes about its sources

```bash
yarn mwops release rights-audit
```

The audit reads files and changes no state. It prints the source register's admissions and refusals,
each published weights package's artifacts, digests, attribution and lineage, and any frozen training
manifest. It then separates what the pass established from what it left open. Read the `Unresolved`
section first. An empty `Unresolved` section means "this pass found no source it could not read" and does
not mean the sources are cleared.

The generated `LICENSE.md` and `PROVENANCE.json` reach a tarball because each workspace's `files`
array lists them, and the audit reports a package whose manifest omits one. `10.0.0` predates both
files, so no tarball on npm carries either one today, as measured in
`docs/engineering/reference/artifact-rights-inventory.mdx`. The next release corrects this. A published
tarball is never altered.

## Admin merges — the one sanctioned bypass

Branch protection requires a green `test` run, and `gh pr merge --admin` bypasses it. Four PRs
merged that way on 2026-08-24, and two board rows shipped with stale pins that surfaced a day later
on the first branch that ran the suite. The bypass stays available for nights when the CI fleet is
slow, through exactly one route:

```bash
mailwoman release merge-admin <pr-number> [--method merge|squash|rebase]
```

The command verifies that the local checkout is at the PR's head and runs the sub-second guards
relevant to the changed paths. Today that is the board-pin check for anything touching the gauntlet
cases, loader, or pin test. It prints which checks ran and refuses to merge over a failure. A bare
`gh pr merge --admin` is not a sanctioned route. The `Board Pins` workflow is the backstop. It runs
path-filtered on PRs and main pushes, plus a daily audit that opens one deduplicated issue when a stale
pin reaches `main`.

## Before you ship — the Gauntlet

Before shipping a model (or any change that can move a coordinate), run the full-pipeline Gauntlet.
It grades the assembled output (coordinate + tier) instead of per-tag F1. #566 showed why per-tag F1 is
not enough.

```bash
# Self-check on the shipped default (regression + metamorphic):
node packages/mailwoman/out/cli/index.js eval gauntlet

# Promote check for a candidate model (adds the held-out candidate-vs-prod z-test):
node packages/mailwoman/out/cli/index.js eval gauntlet --candidate ./out/<version>/model.onnx [--source us]
```

A non-zero exit blocks the ship. The Gauntlet has three layers (`mailwoman/eval-harness/gauntlet/`):

- **Regression** is the curated executable bug log, so a fixed bug must stay fixed. It requires
  `status=pass` and tracks `known_fail`/`improvement_target`.
- **Metamorphic** checks INV/DIR surface-form relations that cannot be gamed. Every relation must hold
  apart from tracked xfails.
- **Held-out** draws a fresh BAN/FDIC sample and runs a candidate-vs-prod z-test. It blocks on
  generalization and wins when the layers conflict.

The Gauntlet is not yet a `release-it` hook. Wire it into the release flow once the candidate path is
standardized.

## Real release

```bash
yarn release
```

The command prompts for the version (or pass `--patch` / `--minor` / `--major` / `--ci`). The plugin then:

1. Bumps `package.json#version` across all listed workspaces in sync.
2. Commits the bumps with message `release: v<version>`.
3. Tags the commit `v<version>`.
4. Pushes the commit and tag to `origin/main`.
5. Runs `npm publish` in each workspace dir.
6. Creates a GitHub release at `v<version>` with autogenerated notes.

## Regenerate the SBOM (post-publish)

Once the new version is on npm, regenerate the Software Bill of Materials so the docs site carries an
SBOM for the release in both open standards (SPDX 2.3 + CycloneDX 1.5):

```bash
yarn mwops release sbom --version <version>   # writes docs/static/sbom/mailwoman-<version>.{spdx,cdx}.json
```

Commit the two files with the release. The generator reads the **published** tarball, so it must run
after publish. Validation commands and rationale live in
[`docs/records/site-2026-08/licensing/sbom.md`](./docs/records/site-2026-08/licensing/sbom.md), and the script header explains the
SPDX normalization. A follow-up would fold this into the `publish` workflow as an automated commit-back
step. It is deferred because it needs a bot commit into `main` after the publish job, which is more than a
one-line addition to `publish.yml`.

## Source data for the weights packages

`copy-weights.ts` reads the trained-binary filenames from **`release.config.json`** (`weights.model` /
`weights.tokenizer`), which is the single place the versioned names live, and resolves them against
`$MAILWOMAN_DATA_ROOT`. Bump the model there when a new model ships, and the script resolves and copies the
real artifacts. Override them per run through environment variables:

```bash
MAILWOMAN_DATA_ROOT=/some/other/root          # the machine's data dir
MAILWOMAN_PUBLISH_MODEL=/path/to/model.onnx \  # absolute path, wins outright
MAILWOMAN_PUBLISH_TOKENIZER=/path/to/tokenizer.model \
  yarn release
```

The binaries are gitignored in the workspace dirs (`neural-weights-*/.gitignore`) and exist only between
`copy-weights` and the post-publish cleanup. **Always confirm that the tokenizer matches the model.** The
model card's `training.tokenizer_version` is authoritative, and mismatches have shipped before.

## Rebuilding + swapping the canonical admin gazetteer (`admin-global-priority.db`)

The resolver's gazetteer is the custom WOF SQLite DB at
`$MAILWOMAN_DATA_ROOT/db/wof/admin-global-priority.db`. It is **never** an off-the-shelf geocode.earth dump,
which uses different WOF ids (see `feedback-custom-wof-db-only`). It is not part of the npm/HF release and
ships separately as the demo's slim derivative, described in the next section. Rebuild it when you add
locale coverage or fix a source-ingest bug (#1015). The artifact is sealed read-only (0444). Never mutate it
in place. Rebuild it, verify it, then swap it.

The coverage recipe lives in code, in `mailwoman/gazetteer-pipeline/defaults.ts` (86 Overture + 161 GeoNames +
11 WOF-priority countries + the pinned Overture release), and is reviewed like code.
`data/gazetteer/wof-build-manifest.json` is the auto-appended build log (what ran, when, check the output,
md5). The build command writes it, so it cannot fall behind the artifact. #1015 required reconstructing
this information from the artifact before the log existed.

### Step 1 — build + verify + seal (one command)

```bash
yarn compile
node packages/mailwoman/out/cli/index.js gazetteer build admin        # ~10 min; builds to admin-global-priority.REBUILD.db
```

One command runs the whole pipeline: WOF ingest → Overture divisions (real `division_area` extents +
country nodes, #1015) → GeoNames folds → freeze (ancestors closure → `ancestors(id)` index →
`wof:hierarchy` −4 backfill → coincident_roles) → enrich (region abbrevs + `place_abbr`, the steps the
2026-07-07 rebuild missed) → FTS (`place_search` + `place_bbox`) → the **structural verify step** → seal
0444 → build-log append.

The verify step also runs standalone with `node packages/mailwoman/out/cli/index.js gazetteer verify --db <path>`.
It checks a per-country node census against the committed baseline (`gazetteer-pipeline/verify-baseline.ts`,
which covers the #1026 failure, where count checks passed while 95 countries lost their country node). It
also checks the coverage floor, a VT→Vermont abbreviation spot-check, `place_abbr` presence, FTS/bbox
coverage, a degenerate-extent spot-check, and the reverse EU panel (capitals and border cities → correct
country, the #1015 failure). **A failed check leaves the artifact unsealed and exits non-zero. Do not swap
it.** Update the baseline deliberately: regenerate it through `generateBaseline` and review the
`verify-baseline.ts` diff like code.

When the change could move coordinates, also run the forward no-regression eval (same US eval, same model,
old vs new DB). The two `**neural**` rows must match:

```bash
PC=$MAILWOMAN_DATA_ROOT/db/wof/postalcode-us.db
for db in admin-global-priority.db admin-global-priority.REBUILD.db; do
  node packages/mailwoman/out/cli/index.js eval oa-resolver \
    --eval data/eval/external/openaddresses-us-sample.jsonl --limit 2000 --default-country US \
    --model <v.onnx> --tokenizer <tok.model> --model-card neural-weights-en-us/model-card.json \
    --model-anchor-lookup <anchor.json> \
    --wof-db "$MAILWOMAN_DATA_ROOT/db/wof/$db,$PC" 2>/dev/null | grep '\*\*neural'
done
```

### Step 4 — swap + record

```bash
cd $MAILWOMAN_DATA_ROOT/db/wof
mv admin-global-priority.db admin-global-priority.db.pre-<change>-bak   # back up the live DB
mv admin-global-priority.REBUILD.db admin-global-priority.db           # promote (instant; same fs)
# The hosted drop-in services hold the DB open — restart them to pick up the new file:
systemctl --user restart mailwoman-photon.service                       # + nominatim if running
```

The build freezes to `journal_mode=delete` + VACUUM, so there are no `-wal`/`-shm` sidecars to carry. A
long-running server that already opened the old inode keeps serving it until restarted. The `mv` is atomic
on disk, but processes do not re-`open()` the file on their own. The build command has already appended the
build log (`data/gazetteer/wof-build-manifest.json`). Commit it with the swap.

### Step 5 — propagating to the demo/browser (rebuild the candidate gazetteer)

The swap above updates the **full** local gazetteer, so every Node eval and the Node resolver see the new
coverage immediately. The **browser demo does not.** It loads these tiers over `sql.js-httpvfs` (byte-range
SQLite):

- **Admin tier** (locality/region/postcode): the global **candidate table**, through `WofCandidateTableLookup`
  in `docs/src/shared/httpvfs-resolver.ts` → `adminGazetteerUrl()` in `resources.tsx`.
- **Street tier** (address points / interpolation): per-state `situs-<state>.db` / `interp-<state>.db`
  byte ranges read from the database on R2, in `docs/src/pages/demo/index.tsx`. (Night-15, #583/#585/#638.)

The candidate table (`build-candidate.ts`, 2026-06-20) **retired the slim `wof-hot.db`**. It is an FTS-free,
`WITHOUT ROWID` B-tree keyed on `name_key`, so a resolve is one contiguous probe (~12 range fetches per
session against 243 on the full DB). It has **global** coverage in one ~490 MB file, so `SLIM_COUNTRIES` no
longer needs upkeep. It is **model-independent**, so it is hosted on its own dated, version-independent path
instead of as a per-release asset. See `project-candidate-table-byte-range`.

To get new admin coverage into the demo after a gazetteer rebuild:

**Turnkey:** `mailwoman gazetteer` commands wrap the whole pipeline below, with every decision set as a default (fold countries, postcode set, FTS, the dated version):

```bash
# fold + build + promote + publish + demo bump, one shot (source .env for the R2 creds first):
set -a; . ./.env; set +a
mailwoman gazetteer release                     # add --dry-run to preview the R2 upload
# …or run the stages independently:
mailwoman gazetteer build                       # durable fold → candidate build (FTS baked in)
mailwoman gazetteer promote                      # symlink <data-root>/db/wof/candidate.db → the build
mailwoman gazetteer publish [--gazetteer-version 2026-06-27a]   # R2 upload + demo ADMIN_GAZETTEER_VERSION bump
```

The manual recipe below performs the same steps one at a time, for reference and one-off variations:

```bash
# 0. DURABLE upstream GeoNames-alias fold (#743/#193). Fold the bilingual / alt-language place-names
#    into a COPY of the admin DB's canonical spr/names so the candidate build carries Karjaa↔Karis
#    natively (FI hard-resolve 69.5→85.8%, coverage 74.4→94.0%) — the alt-name attaches to the real
#    WOF place ("Karjaa" → Karis) rather than a duplicate row. Reuses ingestGeonamesAliases +
#    buildPlaceSearchFts; the canonical admin DB is never mutated. Supersedes the retired
#    candidate-side stopgap (build-candidate-geonames-aliases, which patched a built candidate.db to
#    MEASURE the lift before this became the durable home — the fold now lives in
#    mailwoman/gazetteer-pipeline/admin/fold-geonames.ts, run by `mailwoman gazetteer build`).
# (the standalone script is retired — the fold lives in the pipeline and `gazetteer build`
#  runs it; for a fold-on-copy without a full rebuild, `mailwoman gazetteer build --help`.)
node packages/mailwoman/out/cli/index.js gazetteer build   # admin (fold included) → candidate, turnkey
# 1. Build the candidate table from the FOLDED admin DB + the postcode databases. The FTS5-trigram fuzzy
#    index (typo tolerance — Manchestr→Manchester) is baked in by build-candidate now; no separate step.
#    --postcodes is repeatable: US + the WOF intl extract (NL/FR/DE/ES/IT) + the GeoNames intl extract (PT/AU)
#    + Overture-derived postcode centroids (CA + the EU-coverage locales), each built with
#      node packages/mailwoman/out/cli/index.js eval es-postcode-centroids --country <CC> --pc-len 0 --parquet <addresses-cc.parquet>
#    (--pc-len 0 = no lpad, the Overture-to-Overture / non-numeric-format case). Each ZIP becomes a
#    `postalcode` candidate row so findPlace(postalcode) resolves directly, and postcodes resolve ~100%
#    at ~1-2km even where the locality misses (LT 0→100%, NO 75→100%, FI/SK 80→100%). The demo cascade
#    country-checks an ambiguous postcode (10115 = Berlin DE + NYC) by resolving the locality first. GB
#    (2.6M) is left out for size.
node resolver-wof-sqlite/out/build-candidate-cli.js \
  --in  $MAILWOMAN_DATA_ROOT/db/wof/admin-global-priority-geonames.db \
  --postcodes $MAILWOMAN_DATA_ROOT/db/wof/postalcode-us.db \
  --postcodes $MAILWOMAN_DATA_ROOT/db/wof/postalcode-intl.db \
  --postcodes $MAILWOMAN_DATA_ROOT/db/wof/postalcode-geonames-intl.db \
  --postcodes $MAILWOMAN_DATA_ROOT/db/wof/postalcode-ca-overture.db \
  $(for cc in at be ch cz dk es fi hr lt lu lv no pl pt si sk; do echo --postcodes $MAILWOMAN_DATA_ROOT/db/wof/postalcode-$cc-overture.db; done) \
  --out $MAILWOMAN_DATA_ROOT/db/wof/candidate-global.db
# 2. Bump ADMIN_GAZETTEER_VERSION in docs/src/shared/resources.tsx (the immutable cache needs a fresh URL).
# 3. Upload to the new path:
mkdir -p /tmp/stage/gazetteer/<NEW_VERSION>
ln -s $MAILWOMAN_DATA_ROOT/db/wof/candidate-global.db /tmp/stage/gazetteer/<NEW_VERSION>/candidate.db
set -a; . ./.env; set +a
python3 docs/scripts/publish-demo-assets-to-r2.py --src /tmp/stage --prefix mailwoman
# 4. The map-highlight sibling (wof-polygons.db) builds from --admin now (the --points wof-hot.db source is
#    gone): mailwoman gazetteer polygons --admin <admin.db> [--countries US,DE,FR] --out wof-polygons.db
```

`hasWofDB: true` stays in `releases.json`. The demo enables the admin tier only when it is true, and it now means
"this version has admin resolution", which the version-independent candidate gazetteer always provides.
Validate with `cd docs && yarn build`, serve, and `MAILWOMAN_DEMO_URL=http://localhost:7770 yarn test:e2e
test/browser/200-demo-resolve.spec.ts` (the Chicago locality and ZIP-only marker cases must pass).

**Guard the byte-ranged `.db` objects from full-file downloads** (the candidate table is ~490 MB) with a
Cloudflare WAF custom rule. This is configuration only and needs no Worker. In the `sister.software` zone →
Security → WAF → Custom rules, block a plain `GET` of any `.db` under `/mailwoman/` that arrives without a
`Range` header:

```
http.request.method eq "GET"
and starts_with(http.request.uri.path, "/mailwoman/")
and ends_with(http.request.uri.path, ".db")
and not any(http.request.headers["range"][*] != "")
```

Action: **Block**. (Deployed 2026-06-20 on the `sister.software` zone, `http_request_firewall_custom`
phase. Verified: scraper GET → 403, demo `Range` GET → 206, VFS `HEAD` → 200.) Legitimate `sql.js-httpvfs`
traffic always sends `Range`, so it passes. The rule is scoped to `GET` intentionally. The VFS sends a
range-less **HEAD** to probe the file length on open, so blocking all methods would break the demo's cold
start. (The rule covers the candidate, the situs/interpolation street databases, and `wof-polygons.db`. You
can use Managed Challenge instead of Block, or tighten it to `contains "/mailwoman/gazetteer/"`.) Cloudflare
custom rules take a few minutes to propagate to all edges, so do not conclude that the rule failed from a
test in the first ~60 s.

## Versioning policy

- **Full sync.** Every package in `.release-it.json` shares one version per release, including the model. The
  workspaces plugin enforces this. `release.config.json#version` carries that number, and the model card's
  `version` and the demo's `releases.json` are bumped to match.
- **The model version follows the release.** The underlying trained artifact keeps its own identity (filename,
  training step, tokenizer) under `release.config.json#weights` and in the model card's `model_lineage`. The
  published `version` is the unified release number (e.g. the Stage-3 / step-100000 model shipped as `4.0.0`).
  This replaces the old "weights versioned to the model" scheme, which the sync-mode plugin could never
  express. That mismatch caused the version drift before 4.0.0.

## Promoting a NON-default model (the full promotion flow)

Most releases are code-only (`yarn release` / the `publish` workflow at the next version, with the model
unchanged). **Promoting a different trained model to be the new default is a bigger operation.** It has broken
this pipeline more than once, because the moving parts are not obvious. This section is the ordered runbook,
first walked end to end for v4.11.0 (the v1.8.0 fr-admin-split promotion). Do the steps in order and verify each.

### Fast-path cheat sheet (lessons from the v4.15.0 promotion)

Read this first. Once you know the steps, a promotion takes about 30 minutes. It involves three independent
backends, and a promotion is not done until all three agree on one md5:

| backend       | tool                                        | what it feeds                                                                 |
| ------------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| **npm**       | `publish.yml` (CI, OIDC)                    | library consumers; **fetches the binary from HF**, so HF must be staged first |
| **HF bucket** | `mailwoman release hf`                      | the npm fetch source + HF-direct `loadFromWeights`                            |
| **R2/demo**   | `docs/scripts/publish-demo-assets-to-r2.py` | the browser demo (reads `public.mailwoman.ai` rather than HF)                 |

The end-to-end order that worked: **the promotion eval (revised if needed) → commit card+config to main → HF stage → `publish.yml` (real) → verify npm md5 → R2 demo repoint.** Each of the following notes records a trap that once cost time:

- **Only two model-card fields can break the pipeline**: `version` (publish.yml derives `MODEL_VERSION` from it) and `files_md5.model.onnx` (re-verified at `yarn pack`). Everything else in the card (`model_lineage`, `phase`, `training`, `notes`, `base_relpath`, the `eval` block) is provenance. Get it right, but a typo there will not break the publish. Move quickly on the prose and carefully on those two fields.
- **The `neural-weights-fr-fr` card drifts silently.** release-it only touches `package.json`, so the card is not bumped automatically and its `version` and `model_lineage` go stale. It was once found stuck at `4.6.0` / "v1.5.0-fr-order" long after it had started shipping the en-us binary. Reconcile both fields in every model promotion.
- **`release.config.json` drifts silently from the card, and copy-weights trusts the config.** The card decides _which_ model ships, but `release.config.json#weights.model` is the path that copy-weights.ts materializes from. The config must change in the same commit as the card (Step 1 items 2+3). When it does not, copy-weights materializes the superseded model and the Gauntlet grades it without warning. In #1024 the config lagged at v220 `a64ad2e6` while the v5.4.0 promotion shipped v230 `ea785a70`, which cost a bisect. **Guardrail (#1024):** the Gauntlet harness now asserts that the materialized `neural-weights-en-us/model.onnx` md5 equals the card's `files_md5["model.onnx"]` for the shipped default, and fails on a mismatch. The Gauntlet is the release `before:release` step, so a drifted config can no longer ship. #1005 fixed the dev-weights-symlink form of the same problem, and #1024 fixed the release-config form.
- **The floor comparison is `>=`** (`mailwoman eval promote`, `mailwoman/eval-harness/promotion-eval.ts`). A floor set exactly at the measured value passes (95.0 ≥ 95.0), so you do not need to set it lower or re-run to check. A promotion eval that needs a lower floor gets a **new eval file** with a stated `$revision_*` reason, so floors never drift silently. The full promotion eval takes ~12–15 min, so set the floors correctly the first time.
- **The R2 demo repoint carries files forward and overwrites two of them.** Between model versions only `model.onnx` and `model-card.json` change. The tokenizer, `fst-en-US.bin`, `postcode-*.bin`, `wof-polygons.db`, `anchor-lexicon-v1.json` and `calibration.json` are byte-identical. The fastest path is to boto3-`download` all of the prior `en-us/v<PRIOR>/` (the exact serving bytes), `cp` the new `model.onnx` + `model-card.json` over them, rebuild `releases.json` (prepend the entry and set `defaultVersion`), and run `publish-demo-assets-to-r2.py --src` once. That is ~60 MB and two commands. (The bucket is `nexus-public`, and the credentials are `RCLONE_S3_PUBLIC_*`.)
- **The npm CDN tarball lags ~10 min behind the version metadata.** Right after publish, `npm view <pkg>@<ver> version` already returns the new version, but `npm pack` returns 404 and a raw tarball `curl` returns a small error JSON. That behavior comes from CDN propagation, and the publish succeeded. In the meantime, verify through `npm view … dist.unpackedSize` (a code-only package is <1 MB, and a model-bundled one is ~33 MB) and the md5 chain `$MAILWOMAN_DATA_ROOT source == HF upload == R2 staging`. Run `npm pack` again once the CDN catches up.
- **Canonical artifact paths:** model int8 → `$MAILWOMAN_DATA_ROOT/models/quantized/model-v<NNN>-step-<step>-int8.onnx`; tokenizer → `$MAILWOMAN_DATA_ROOT/models/tokenizer/<ver>/tokenizer.model`; FST → `$MAILWOMAN_DATA_ROOT/db/wof/fst-per-locale/fst-<locale>.bin` (HF stage renames it to BCP-47 `fst-en-US.bin`); postcode soft-feeds → `neural-weights-<locale>/postcode-<cc>.bin`; gazetteer lexicon → `data/gazetteer/anchor-lexicon-v1.json` (the repo copy the promotion eval ran against; use it instead of the prior bucket's copy).

### Step 0 — figure out the version number (the divergence trap)

The npm packages and the demo model **drift apart**. Code-only releases bump npm (`mailwoman` → 4.7, 4.8, … on
npm), while the demo/HF model stays at the version that last shipped a model (e.g. `v4.6.0`). They share a
number namespace but are not in lockstep at any given moment. Check both:

```bash
curl -s https://registry.npmjs.org/mailwoman | jq -r '."dist-tags".latest'      # e.g. 4.10.0 (npm code)
curl -s https://public.mailwoman.ai/mailwoman/en-us/releases.json | jq -r .defaultVersion  # e.g. v4.6.0 (demo model)
```

**The new release must exceed the npm `latest`**, because npm refuses to republish an existing version. The
number is therefore `max(npm-latest, demo-default) + one minor`. For v4.11.0, npm was at 4.10.0 and the demo
at v4.6.0, so the release shipped as `4.11.0`. Do not take the next number after the demo's model version,
because it will collide with npm.

### Step 1 — promotion is a model-card REWRITE rather than a relabel

When the model you are shipping is not the current default, the repo still describes the old model. Make
these updates in `main` before staging anything:

1. Place the int8 in the canonical dir: `cp <staged>/model.onnx $MAILWOMAN_DATA_ROOT/models/quantized/model-v<NNN>-step-<step>-int8.onnx` and confirm its md5 against the promotion eval or the postmortem.
2. In `release.config.json`, bump `version`, repoint `weights.model`, update `weights.lineage` + `weights.trainingStep`, and put the new int8 md5 in the lineage string.
3. In `neural-weights-en-us/model-card.json`, rewrite `version`, `model_lineage`, `phase`, `training`, `notes`, `base_relpath`, the `eval` block (the promotion eval evidence), and `files_md5`. **State any regression that crosses the 2pp threshold** in the card itself. `requires` (the ship-config) is unchanged when the model reused the prior recipe.
4. Regenerate the capabilities manifest. The fail-closed capabilities delta check reads it, and without a regeneration the generator's `$comment` names the wrong model. The generator **refuses to run if a `capabilities` block already exists**, so rewrite the card without that block first, then run:
   ```bash
   yarn compile   # the generator imports COMPILED @mailwoman/neural/scorer from out/
   node packages/mailwoman/out/cli/index.js eval capability-manifest \
     --model $MAILWOMAN_DATA_ROOT/.../model-v<NNN>-step-<step>-int8.onnx \
     --tokenizer $MAILWOMAN_DATA_ROOT/.../tokenizer.model \
     --model-card neural-weights-en-us/model-card.json --write
   ```
5. Commit and **push to main**. CI derives the HF fetch path from the model card on `main`, so the card must be pushed before the CI publish.

### Step 2 — carry forward the resolver/gazetteer layer from the PRIOR bucket

A release dir is self-contained, because the demo fetches everything from `en-us/<version>/`. Only
`model.onnx`, `tokenizer.model`, `model-card.json`, and (if it changed) `anchor-lexicon-v1.json` are new. The
resolver/gazetteer layer (`fst-en-US.bin`, `wof-hot.db`, `wof-polygons.db`, `postcode-*.bin`) carries forward
**unchanged**. The safest source is the exact bytes the prior version already serves, because a local rebuild might
differ. List and pull the files from the prior R2 path, and verify their sizes:

```bash
B=https://public.mailwoman.ai/mailwoman/en-us/v<PRIOR>      # e.g. v4.6.0
for f in fst-en-US.bin wof-hot.db wof-polygons.db postcode-us.bin postcode-de.bin postcode-fr.bin; do
  curl -sI "$B/$f" | head -1   # confirm 200 + note Content-Length
done
```

Assemble a staging dir mirroring the R2 layout: `<src>/en-us/v<NEW>/{the 10 artifacts}` plus
`<src>/en-us/releases.json` (take the live R2 `releases.json`, prepend the new entry, set
`defaultVersion`). `anchor-lexicon-v1.json` should be the **repo** copy (`data/gazetteer/anchor-lexicon-v1.json`),
because the model was evaluated against that lexicon, and it can differ by a few bytes from the prior bucket's copy.

### Step 3 — stage HF, then R2, then verify both backends agree

```bash
HF_TOKEN=$(cat ~/.cache/huggingface/token) node packages/mailwoman/out/cli/index.js release hf v<NEW> \
  --locale en-us --label "..." --description "..." \
  --model <src>/.../model.onnx --tokenizer ... --model-card ... --fst <src>/.../fst-en-US.bin \
  --wof-hot <src>/.../wof-hot.db --gazetteer-lexicon <src>/.../anchor-lexicon-v1.json \
  --postcodes "<csv of postcode-*.bin>" --pair-indexes "<csv of pair-index-*.bin, if any locale ships one>" \
  --polygons <src>/.../wof-polygons.db --steps <step> --set-default

set -a; . ./.env; set +a; python3 docs/scripts/publish-demo-assets-to-r2.py --src <src>
```

The flag list above does not define what a release must stage, and this prose has gone stale before.
After staging, run `yarn release:preflight --source hf` (see the preflight section above). It derives the
required object set from the weights packages' own `files` arrays and lists every object that is not
readable, so an incomplete staging fails locally instead of wasting a publish dispatch.

Pass `--postcodes` + `--polygons` to the HF script too. Otherwise its `releases.json` gets `hasAnchor:false`
/`hasPolygons:false`, because it probes R2 for them and R2 is not staged yet. `--pair-indexes`
(placetype-pair-prior arc, Task 8) is country-specific by design. Omit it entirely for a release where no
locale ships a pair index. Today `en-gb` (`pair-index-gb.bin`) and `en-nz` (`pair-index-nz.bin`) ship one,
driven by `release.config.json`'s `softFeed.pairIndexByCountry`. (`en-nz` ships no postcode binary, because no
WOF NZ postcode extract exists yet. See `neural-weights-en-nz/model-card.json`'s `no_postcode_bin` follow-up.)

#### Character-path families stage under their own directory (`cjk/<version>/`)

`@mailwoman/neural-weights-cjk` ships `model.onnx` + `char-vocab.json` and no tokenizer. Its graph has the same
basename as the Latin base's graph but different bytes, so it is never staged into `en-us/<version>/`.
`--char-vocab` selects the family layout, the directory is `<locale>/<version>` with the family's card version,
and no `releases.json` entry is written, because the demo does not serve it.

```bash
HF_TOKEN=$(cat ~/.cache/huggingface/token) node packages/mailwoman/out/cli/index.js release hf v<CJK CARD VERSION> \
  --locale cjk --label "…" --description "…" \
  --model $MAILWOMAN_DATA_ROOT/models/<run>/served-package/model.onnx \
  --char-vocab $MAILWOMAN_DATA_ROOT/models/<run>/served-package/char-vocab.json \
  --model-card packages/neural-weights-cjk/model-card.json
```

`fetch-hf-weights` plans a family from `release.config.json`'s `charWeights` only once its workspace is in
`.release-it.json`'s list. It reads the family from `<family>/v<card version>/` and verifies it against the
family's own `files_md5`. The preflight `--source hf` reports any unstaged object before a dispatch.

#### FST artifacts with no builder — what not to re-publish (#1493)

Four FST binaries in `$MAILWOMAN_DATA_ROOT/db/wof/` predate the `FST_LOCALES` registry (#1318), and
**no code in the tree can rebuild them.** `mailwoman gazetteer build fst` throws on any locale missing
from `FST_LOCALES` (`mailwoman/gazetteer-pipeline/fst.ts:428`), and its output template
(`fst-<locale>.bin`) cannot express the global file's name. `mailwoman gazetteer verify` reports them as
`NO BUILDER — … has no FST_LOCALES entry`. That row is the intended signal and should not be silenced.

- **`fst-global-priority.bin` was retired on 2026-08-06. Do not stage it, and do not re-publish it.**
  No code in the tree loads it. The only in-tree reference is the freshness inventory
  (`ADMIN_DERIVED_FST_ARTIFACTS`), which `openSync`s the 32-byte header and never reads the body. Every
  real FST load resolves `fst-${locale}.bin` from a weights package (`neural/weights.ts:382`), so the
  global artifact has had no consumer since #1318. The same change removed its last mention in a shipped
  card (the retired v0.6.2 model-card template's `inference.admin_fst`).
  **One-time release action for the operator:** delete the file from the HF `sister-software/mailwoman`
  bucket. Leaving it is harmless, since it is a 317 MB orphan with a 2026-05-28 build stamp, so this is a
  cleanup and never a release blocker.
- **`fst-{ja-jp,zh-cn,ko-kr}.bin` are frozen and stay published.** They have the same no-builder status,
  but they are the only CJK gazetteer artifacts that exist, and `hf-publish/mailwoman-wof-gazetteer/README.md`
  documents them (ja-JP 13.0 MB, ko-KR 7.1 MB, zh-CN 92.5 MB). They are **frozen at their 2026-05-28 build**
  and should be regenerated only when the JP serving arc lands (`ROAD_TO_V9.md` §8; the 0.9928 char model
  has no serving path yet). Until then, leave them where they are, do not re-stage them, and do not cite
  them as current. To regenerate them, first give them `FST_LOCALES` entries with country scopes. The
  existing `gazetteer build fst` command then suffices.

**A release is done only when both backends agree.** CI's weight fetch reads HF, and the demo reads R2:

```bash
curl -s .../en-us/releases.json | jq -r .defaultVersion         # HF and R2, both == v<NEW>
curl -s .../en-us/v<NEW>/model.onnx | md5sum                     # HF and R2, both == the conditional md5
```

#### Pair-index binaries are VERSIONED (2026-08-05); the un-versioned path is FROZEN

`--pair-indexes` above stages the binaries on **Hugging Face**. The copies that the browser demo reads require a
separate push. They reach the bucket only through `publish-demo-assets-to-r2.py`, from a `--src` tree you
assemble by hand. No other tool produces them. `publish.yml` downloads them from HF into the weights workspaces
for the npm tarballs, and the docs runtime-assets plugin copies them into the Pages deploy for dev preview only.

Stage them under a generation segment:

```
<src>/pair-index/<generation>/pair-index-{gb,nz}.bin      # e.g. pair-index/2026-08-05/
```

- The generation is `PAIR_INDEX_VERSION` in `docs/src/shared/resources.tsx`. **Bump it in the same commit in
  which you stage a new generation**, the same way `ADMIN_GAZETTEER_VERSION` / `POI_LAYER_VERSION` /
  `NATIONAL_STREET_DATABASE_VERSION` work. The demo bundle holds the mutable pointer, and the binaries are
  immutable at a fresh URL.
- These objects ship `Cache-Control: public, max-age=604800, immutable`. The PIX schema-3 republish was
  uploaded over the flat `mailwoman/pair-index/pair-index-<cc>.bin` keys, so Cloudflare kept serving schema-1
  bytes that the site's reader rejects. The demo lost the GB/NZ `dependent_locality` priors until a manual
  purge.
- `publish-demo-assets-to-r2.py` now refuses a `--src` that puts a pair-index binary at the flat key, so the
  script enforces this rule.
- The flat keys stay in place, frozen, and no new key is written to them. The demo HEAD-probes the versioned
  path and falls back to the flat keys with a `console.warn` until the first release train stages a
  generation. After that, delete `resolvePairIndexBaseURL`'s legacy branch (and `LEGACY_PAIR_INDEX_BASE_URL`).

### Step 4 — publish npm from CI (two-phase, PR-based), then verify registry-direct + a clean install

The "Production Integrity" ruleset on `main` (2026-07-22) requires every change, including the release
version-bump commit, to land through a PR with a green `test` check. The publish is therefore two dispatches
around an auto-merging PR:

```bash
# Phase 1: bump versions on release/v<NEW>, open the PR, auto-merge when `test` is green
gh workflow run publish.yml -f mode=prepare -f version=<NEW>
gh run watch <id> --exit-status
gh pr view release/v<NEW> --json state,mergeStateStatus   # wait for MERGED

# Phase 2 (after the merge): tag + GitHub release + npm publish of the merged commit
gh workflow run publish.yml -f mode=publish
gh run watch <id> --exit-status
```

`npm view` caches for minutes, so verify against the registry directly. Then check that the whole closure
installs, which catches the broken clean install from #596:

```bash
curl -s -o /dev/null -w '%{http_code}' https://registry.npmjs.org/mailwoman/<NEW>     # 200
cd $(mktemp -d) && npm init -y >/dev/null && npm install mailwoman@<NEW> --dry-run     # exit 0, no 404
```

### Step 5 — refresh the docs' release-bound numbers

Every model promotion leaves the same three kinds of stale content behind, such as a number copied from
the old card or a CLI capture from the old weights. Do this after Step 4, once the model is live, so that
captures run against the real shipped weights instead of a staging candidate:

1. **Refresh the model-card-derived numbers** on the known pages. **This list predates the site
   restructure, and most of it no longer points to a published page (see #2259).** The published tree is
   `docs/articles/` (`docusaurus.config.ts` sets `path: "articles"`). `docs/records/site-2026-08/` is
   the archived August site and must not be edited at release. The live pages today are
   `docs/articles/developers/status.mdx` and the homepage (`docs/src/pages/index.tsx`).
   `docs/src/components/AboutDemo/AboutDemo.tsx` is gone from the tracked tree, and only a compiled
   remnant under `docs/out/` survives. The flagship concept pages, the tokenization page,
   the from-Pelias page and `releases.mdx` survive only under `docs/records/site-2026-08/`, so decide
   whether each returns to the published tree or leaves this list. For params, vocab size, and int8/fp32
   size, byte-verify each value against **the model card** `neural-weights-en-us/model-card.json`
   (`architecture`, `format`, `files_md5`), and do not trust the prose you are replacing. A fine-tune from
   the same lineage may change none of these values, so confirm through the card instead of assuming drift.
   These values are a **different measurement** from the npm package download/unpacked size quoted in
   `getting-started.mdx`. Get those sizes from the registry, never by arithmetic: `npm view
@mailwoman/neural-weights-en-us@<version> dist.unpackedSize` for the unpacked figure, and a
   `curl -r 0-0` range-request (`content-range: bytes 0-0/<total>`) against the tarball URL for the
   compressed download figure.
2. **Re-run the docs' captured CLI examples** (`mailwoman parse`, `mailwoman geocode`, the
   `/v1/batch` curl captures) against the newly promoted weights. Refresh only the output blocks whose
   real bytes changed, byte-exact, and leave unchanged blocks and surrounding prose untouched.
   **On a fresh worktree or host, linking `model.onnx`/`tokenizer.model` with `link-dev-weights.ts` is
   not enough.** A model whose card `requires` an anchor/gazetteer/country channel also needs
   `anchor-lexicon-v1.json` + `country-surface-lexicon-v1.json` (copy them from this repo's own
   `data/gazetteer/`) and any `postcode-<cc>.bin` in the weights package dir. Without them the capture
   runs degraded through the legacy rule-only fallback without an error. A stderr banner lists each
   missing channel, so check stderr for it. Re-verify that the md5 check passes with no `#397` error
   before trusting a capture.
   **If the demo is deliberately held on an older model** (because its runtime does not yet feed a new
   required input channel, as in the 6.2.0 precedent below), the demo's own captured screenshots and text
   stay on the old version. Only the library/CLI/server captures move to the new one. State this
   explicitly in `status.mdx`, so the version mismatch does not look like an oversight.
3. **Check `evals/scores-by-version.json` for the new version's row.** `mailwoman eval
ledger-append` writes it, and the promotion eval prints that command in its `PASS` output. The
   operator runs the command from the session that holds the promotion eval's `PASS` output. If your
   task is a docs-only refresh and you do not have that output, do not fabricate or backfill the row.
   Verify whether the row is in the ledger and report it. Also flag any missing row for a prior version
   that you notice, because missing rows otherwise accumulate unnoticed.

`status.mdx` and `releases.mdx` change together or not at all, as each page states. A model promotion
always touches both: it adds a new row to the releases matrix and re-verifies the banner on status.

### The metadata check — `verify-release-metadata.ts` backstops Step 5

Step 5 used to depend on people remembering it, and they sometimes forgot. When 6.4.0 shipped, the eval
ledger, the `releases.mdx` `(current)` row, and the `status.mdx` info box were all left on 6.3.0. The
mistake was caught only at 6.5.0, and all three were backfilled by hand during that release.
`yarn mwops release verify-metadata` now fails the publish early if those three pages have not been
updated. The CI step **Verify release metadata is propagated** runs it after the Hugging Face weight
preflight and before release-it, on both dry and real runs (it is skipped only on `publish_only`
recovery). Run it locally at any time:

```bash
yarn mwops release verify-metadata   # exit 0 = propagated; exit 1 = one actionable error per stale surface
```

It uses the **model** version, which is the `version` field of `neural-weights-en-us/model-card.json` and not the npm/`package.json` version. It checks three things: (1) `evals/scores-by-version.json` has a run for that
`model_version`, (2) `releases.mdx` has a matrix row for it with the `(current)` marker on that row, and
(3) the `status.mdx` `:::info[Verified as of …]` box cites it. Because it reads the model card, a
**code-only release** (npm bumps and the model card does not) passes without error. The `(current)` marker
may sit on a newer row as long as every release above the model version is a documented "model unchanged"
row. A dry run is the operator's last look before the real dispatch, and the check is meant to catch a
forgotten page there. (Out of scope and tracked separately: the isotonic calibration tables still come from
the v5.3.0 lineage, and the metadata check does not verify them.)

### Pitfall: `.release-it.json` must list every runtime dep of `mailwoman`

`yarn pack` translates `mailwoman`'s `workspace:*` deps to concrete `<NEW>` versions. If a dependency's
workspace is not in `.release-it.json`'s list, it is never bumped or published, so `<dep>@<NEW>` returns 404
and `npm install mailwoman` breaks. The record-matcher work added `formatter`/`record`/`match`/`address-id`/`registry`
(and `spatial`), and they are in the list now. **Any future runtime dependency must join it too.** This
repeats the warning at the top of this document, because the mistake recurs.

### Pitfall: partial release — just re-dispatch `mode=publish`

The CI publish can publish most packages and then fail partway. On v4.11.0 a transient npm OIDC
`E401 … Failed to generate Web Auth URLs` hit `record` + `registry` while the other 15 packages published.
`mode=publish` is idempotent by construction. The tag and GitHub release are created only if missing, and
each workspace publish uses `--tolerate-republish`, so already-published packages are no-ops. The recovery
is to run the same dispatch again:

```bash
gh workflow run publish.yml -f mode=publish
```

The E401/Web-Auth error was transient for v4.11.0, and the `publish_only` retry cleared it. If it recurs on
the same packages, their npm Trusted Publisher is unconfigured. Configure it on npmjs.com, or publish the
remaining packages with a token in dependency order (`record` before `registry`). **Note:** older notes say
"the lab host has no npm credentials," but it currently has an `~/.npmrc` authToken. Running
`yarn mwops release publish-workspace --allow-unplanned` in the recovery loop below can therefore finish the
remaining packages from the lab host without OIDC.

## Common failures

| Symptom                                  | Cause                                                 | Fix                                                                                                              |
| ---------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `403 Forbidden` from npm publish         | Token missing publish rights on `@mailwoman` scope    | npmjs.com → tokens → check scope coverage                                                                        |
| `requireCleanWorkingDir` aborts          | Uncommitted changes                                   | `git status`, commit or stash                                                                                    |
| `requireBranch` aborts                   | Not on `main`                                         | `git switch main`                                                                                                |
| Hook `yarn test --run` fails             | Pre-existing test breakage                            | Fix tests or temporarily comment the hook in `.release-it.json` and document the divergence in the release notes |
| `copy-weights.ts` `Missing source model` | Running from a machine without `$MAILWOMAN_DATA_ROOT` | Set `MAILWOMAN_PUBLISH_MODEL` + `MAILWOMAN_PUBLISH_TOKENIZER` env vars                                           |

## Releasing from CI (manual dispatch + npm Trusted Publishing)

`.github/workflows/publish.yml` exposes the same flow from the GitHub Actions UI. Auth uses **npm Trusted Publishing** (OIDC), so the repo has no `NPM_TOKEN` secret and `~/.npmrc` needs no auth token. npmjs.com is configured to accept publishes from this exact workflow file path.

1. **One-time setup on the npm side** (done for the original packages). Each already-published `@mailwoman/*` package and `mailwoman` has a Trusted Publisher configured for the `sister-software/mailwoman` repo and the workflow file `.github/workflows/publish.yml`. If you move or rename that file, update the npm side too. **A package added since then must have its publisher configured before CI can publish it.** See "Adding a new package" below. _(As of 4.0.0, the six packages first published by hand, codex and the five new deps, still need their Trusted Publishers set up.)_
2. **Run a release** from the Actions tab → `publish` workflow → Run workflow. A release takes two
   dispatches, because the "Production Integrity" ruleset requires the version-bump commit to arrive
   through a PR with a green `test` check. The direct release-it push was retired on 2026-07-23 after the
   ruleset started rejecting it with GH013.
   - **`mode=prepare`** with `version` (`patch` / `minor` / `major` / specific semver like `2.1.0`)
     runs the metadata check (`mwops release verify-metadata`) and bumps the root and every
     `.release-it.json` workspace through `mwops release prepare-version`. It pushes
     `release/v<NEW>`, opens the release PR, and dispatches the Test workflow against the branch,
     because PRs created with GITHUB_TOKEN never trigger `on: pull_request` (GitHub's anti-recursion
     rule). It then enables auto-merge. The PR merges itself when `test` is green without a human
     click, so one person working alone at night can still release.
   - **`mode=publish`** (after the PR merges) verifies that main is version-synced, fetches the weight
     binaries from HF at the model-card version, tags `v<NEW>`, creates the GitHub release, and
     publishes every workspace through OIDC. It is idempotent, so re-dispatch it after a partial failure.
   - `dry_run` is a boolean that works with both modes. `prepare` shows the bump diff without pushing,
     and `publish` verifies version sync and compiles without tagging or publishing.

Each workspace publish runs `yarn pack -o <tmpfile>` (which translates `workspace:*` → concrete versions) followed by `npm publish <tmpfile>`. The npm CLI detects the OIDC environment and authenticates through Trusted Publishing, and it enables `--provenance` automatically. CI no longer invokes release-it itself. `.release-it.json` remains the canonical workspace list that both phases derive from, and it is the config for the legacy local flow, which the ruleset now blocks at the push step (dry runs still work).

### Adding a new package: it can't be first-published from CI

**Set the version field first.** A new workspace must join at the current unified version (`npm view
mailwoman version`), never `0.0.0`. `mwops release prepare-version`'s drift guard refuses to bump an
unsynced tree, which blocked the en-nz addition on the first 7.8.0 prepare (2026-07-24).

npm Trusted Publishing (OIDC) **cannot create a package that does not exist yet.** The registry returns `E404` (`PUT https://registry.npmjs.org/@scope%2Fpkg — Not found`) because there is no package, and therefore no Trusted Publisher, to authorize against. A brand-new `@mailwoman/*` workspace therefore needs a **one-time manual first publish with a token** before CI can publish it. This broke the 4.0.0 release: `@mailwoman/codex` and the five new `mailwoman` runtime deps (`kind-classifier`, `locale-hint`, `normalize`, `phrase-grouper`, `query-shape`) all failed OIDC and had to be bootstrapped by hand.

Run the bootstrap on a machine with `npm login` rights to the `@mailwoman` scope. The **lab host has no npm credentials**, so use the operator's machine:

```bash
git checkout main && git pull   # main already carries the release commit's versions
for ws in <new-workspace-dirs>; do
  RELEASE_IT_WORKSPACES_TAG=latest RELEASE_IT_WORKSPACES_ACCESS=public \
  yarn mwops release publish-workspace --workspace ./$ws --plan release-plan.json || break
done
```

> **Use the operation above (write the plan first with `yarn mwops release plan --json > release-plan.json`), or `yarn pack -o <tmp> && npm publish <tmp>`. Never run a raw `npm publish` from the workspace dir.** Yarn 4's `workspace:*` dep protocol is specific to Yarn. `npm publish` ships the literal string `"workspace:*"`, and consumers then fail to install with `EUNSUPPORTEDPROTOCOL`. `yarn pack` (which `publish-workspace.ts` runs) rewrites `workspace:*` → the concrete sibling version. This broke `@mailwoman/address-id`'s 4.9.0 first publish, which shipped `"@mailwoman/codex": "workspace:*"`. Republishing 4.9.1 from a `yarn pack`'d tarball fixed it.

Then, on npmjs.com, **configure each new package's Trusted Publisher** (repo `sister-software/mailwoman`, workflow `.github/workflows/publish.yml`). After that, OIDC publishes it like every other package, and it needs no further manual steps.

`yarn mwops release bless-package --dirs <dir>[,<dir>…] --plan release-plan.json` performs both steps (first publish and trust config) from the terminal. It
runs npm's web-auth flow, so a hardware key on the laptop can sign for a publish from the lab host. **The
workflow filename it registers must be the workflow that publishes** (`publish.yml`). The operation
refuses a name that is not in `.github/workflows/`. npm stores the claim verbatim and never checks it, so npm
accepts a wrong name and then denies every CI publish with a bare `E404 Not Found - PUT` that mentions
neither trust nor the workflow. That error held `neural-weights-{en-in,it-it,es-es}` at 8.6.0 through the
9.0.0 and 9.1.0 releases. They were blessed on 2026-08-02 with this flag's then-default, `release.yml`, a
file this repo has never had. A package that already has a config answers `409 Conflict` to a second
`npm trust github`, whatever that config says. Read the existing config with `npm trust list <pkg>` and
replace a stale one with `npm trust revoke <pkg> --id <id>`, because retrying returns 409 forever.

Two traps wasted time during 4.0.0:

- **`npm view <pkg> version` caches for minutes** and reports `UNPUBLISHED` right after a successful publish. Verify against the registry directly with `curl -s https://registry.npmjs.org/@mailwoman%2F<pkg>`. HTTP 200 with a `dist-tags.latest` means the package is published.
- **npm rate-limits new-package creation.** The bootstrap loop above published the first package and then failed, and the `|| break` stopped it. Waiting a minute and re-running published the rest. A `402`/`403` indicates a different problem: the token lacks publish rights on the scope.

If a release fails partway like this (with the tag and some packages already published), do not re-dispatch the full CI workflow, because release-it will fail on the existing tag. Use the per-workspace bootstrap loop above to publish the remaining packages (`--tolerate-republish` makes already-published versions a no-op), then configure their publishers. See also "Recovering from a partial release" below.

### Models on Hugging Face, then everything publishes from CI

The model store is Hugging Face, specifically the **public** `sister-software/mailwoman` bucket. The demo
fetches from the same bucket at runtime (`docs-build.yml` bundles no binaries). The whole release therefore
runs from CI through OIDC, with **no npm credentials anywhere**. The order is:

1. **Stage the model on HF first.** Run this on the operator's host. It needs only the HF token and no npm auth:

   ```bash
   HF_TOKEN=$(cat ~/.cache/huggingface/token) node packages/mailwoman/out/cli/index.js release hf v<version> \
     --locale en-us \
     --model <model.onnx> --tokenizer <tokenizer.model> --model-card neural-weights-en-us/model-card.json \
     --fst <fst-en-US.bin> --wof-hot <wof-hot.db> --set-default
   ```

   This pushes `model.onnx` + `tokenizer.model` + `model-card.json` + `fst-en-US.bin` + `wof-hot.db` to
   `…/resolve/en-us/v<version>/` and updates the HF copy of `releases.json`. For a relabel of an existing
   model, `fst-en-US.bin` and `wof-hot.db` are unchanged, so copy them from the previous version's bucket path.

   > **⚠️ The HF `--set-default` alone does not switch the live demo** (found on night 10, v4.2.0).
   > `public.mailwoman.ai` serves from the **R2** bucket. Updating the demo is a second,
   > mandatory step. Stage the same artifact set (plus `postcode-*.bin` + `wof-polygons.db`, copied from the
   > prior version's R2 path when unchanged) into the R2 layout and run:
   >
   > ```bash
   > set -a; . ./.env; set +a   # RCLONE_S3_PUBLIC_* creds
   > python3 docs/scripts/publish-demo-assets-to-r2.py --src <staged-dir>
   > ```
   >
   > Verify with `curl -s https://public.mailwoman.ai/mailwoman/en-us/releases.json | jq .defaultVersion`
   > and an md5 of the served `model.onnx` against the artifact the promotion eval passed. CI's weight fetch reads HF; the
   > demo reads R2. A release is done when both backends agree.

2. **Publish all packages from CI** by running `publish.yml` at the same version. The "Fetch weight binaries from
   Hugging Face" step pulls `model.onnx` + `tokenizer.model` from the public bucket (no auth) into the
   `neural-weights-*` workspaces, and the run publishes every package, code and weights, over OIDC.
   `copy-weights.ts` is skipped on CI because its `$MAILWOMAN_DATA_ROOT` paths do not exist there. It is the
   local-dev path. A real run therefore requires the model to already be on HF for that version (step 1).

> A previous version of this workflow pulled weights from a Cloudflare R2 bucket (`mailwoman-assets`). That
> bucket is the **training-data** store (corpus + tokenizer for Modal), not a release store. The pull was
> unreliable and never shipped a model, and it has been removed.

## Client packages

Three workflows build and publish the API clients. `publish.yml`'s `clients` job runs after `publish` succeeds.
It regenerates the Python (`mailwoman-client` on PyPI) and Rust (`mailwoman-client` on crates.io) API clients,
which are typed wrappers over the Photon / Nominatim / libpostal drop-ins plus the native `/v1/*` API, generated
from the OpenAPI documents those APIs already emit. The job uploads them as **inspection artifacts only**.
Registry publishing lives in one dedicated, manually dispatched workflow, **`publish-clients.yml`**. Its
`generate` job builds and verifies both clients once. Per-registry jobs then publish the exact artifact bytes.
The `pypi` job uses Trusted Publishing / OIDC in the `pypi` environment. PyPI's trust binds to the
`publish-clients.yml` filename, so never rename the file without updating the PyPI-side publisher config. The
`cargo` job uses the `cargo` environment, whose `CARGO_REGISTRY_TOKEN` environment secret is the credential.
The `publish_python` / `publish_cargo` dispatch inputs (default true) make single-registry retries cheap,
because no generator reruns. See `docs/records/site-2026-08/api.mdx` "Client libraries" for what the clients
are. This section describes them from the release operator's side.

> **Sequencing: do not publish clients before the next npm release.** The generated clients stamp
> `mailwoman/package.json`'s version and document the `/v1` and emitted-spec APIs, which exist on `main` but
> in **no published npm release yet**. The Hono migration ships in the next release, which is a major
> version. Dispatching either publish workflow before that release would claim the current version number on
> PyPI/crates.io for a client that describes endpoints nobody can install, and both registries permanently
> retire published version numbers. Publish the first clients right after the next npm release.

> **Incident note:** the `clients` job holds the workflow's `publish` concurrency slot, so a `publish_only`
> recovery dispatch queues behind its setup and generate steps, which take minutes on a cold runner. During
> an incident, cancel the running `clients` job from the Actions UI first. It never publishes anything, and
> cancelling it frees the queue immediately. (The two client-publish workflows join the same `publish`
> concurrency group by design, so they cannot race a release into a half-bumped version.)

### Artifacts always build; publishing is its own dispatch

Every dispatch of `publish.yml`, including a `dry_run`, regenerates both clients and uploads them as workflow
artifacts (`mailwoman-client-python`: the wheel + sdist; `mailwoman-client-rust`: a tarball of the assembled
crate). That step always runs. It is the same local, receipt-verified pipeline as `mailwoman clients generate`
(below), so a broken generator, or a spec that changed in a way `progenitor`/`openapi-python-client` cannot
handle, fails the job on every dispatch and not only when someone remembers to check. No step in `publish.yml`
ever reaches a registry.

**A red `clients` job marks the release run as FAILED. That result is a record and does not roll anything
back** (#1892). The job has no `continue-on-error`, so its failure becomes the workflow run's conclusion. The
npm packages are already published when it runs (`needs: publish`, and published versions are immutable), so
read that conclusion as "the release shipped, but the generated Python and Rust clients for it did not". Fix
the generator and dispatch `publish-clients.yml`. Never unpublish or republish the release. This failure went
unnoticed for two releases. The job had failed on every run since the workspace regroup, and the workflow
comment beside it said its failure could not turn a release red.

To publish, dispatch `Publish API clients` (`publish-clients.yml`) from the Actions UI. It builds once from
`main` (the same composite action the release-run inspection artifacts use) and then runs two jobs:

- **`pypi` job:** downloads the wheel/sdist artifact and publishes through Trusted Publishing. PyPI verifies
  the job's `pypi` environment and the `publish-clients.yml` filename in the OIDC claims, so no token is
  needed. `uv publish --trusted-publishing always` fails with a clear error on config drift.
- **`cargo` job:** downloads and extracts the crate tarball and runs `cargo publish` with the
  `CARGO_REGISTRY_TOKEN` secret from the `cargo` GitHub environment. It is not a repo-level secret. The job's
  `environment: cargo` declaration makes it resolvable.

Uncheck `publish_python` / `publish_cargo` at dispatch for a single-registry run (e.g. retrying one
registry after an account-level rejection).

### Registry provisioning — state as of 2026-07-12

The operator provisioned the following:

- **`pypi` GitHub environment** (without secrets, OIDC only) and a PyPI Trusted Publisher configured against
  `publish-clients.yml` (migrated from the retired `publish-python.yml` when publishing was consolidated).
  Before the first dispatch, double-check the PyPI-side pending-publisher entry. The project name must be
  **`mailwoman-client`** (what the generator stamps), the repository `sister-software/mailwoman`, and the
  workflow filename `publish-clients.yml`. If the publisher config specifies an environment, it must be
  `pypi`. The job declares it either way, and a mismatch fails the OIDC exchange with a readable PyPI error.
- **`cargo` GitHub environment** carrying `CARGO_REGISTRY_TOKEN`. crates.io has no pre-claim step, so the
  first successful `cargo publish` creates the crate. Confirm that the crates.io account email is verified,
  because crates.io refuses publishes until it is.

Both registry names (`mailwoman-client` on PyPI and crates.io) were unclaimed as of 2026-07-12. They were
reserved by intent but not yet claimed. The first dispatches claim them.

### Version sync — a client-only fix can't republish alone

The clients have no independent version. `mailwoman clients generate` reads `mailwoman/package.json`, which
holds the version that the `api`/`photon`/`nominatim`/`libpostal` npm packages already release at in lockstep
(see `mailwoman/tools/generate-clients.ts`). It stamps both the Python `pyproject.toml` and the Rust
`Cargo.toml` with that version. This intentionally simplifies the superseded `feat/api-clients` branch's
design, which versioned the clients against the OpenAPI interface independently of the engine release. It
removes one version scheme in exchange for one real constraint: **a client-only fix (a generator bug, a
hand-written ergonomics change in `mailwoman_client/__init__.py` or `src/lib.rs`) cannot ship at a patch
version of its own.** PyPI and crates.io both permanently reject re-publishing an already-used version number,
exactly like npm, so there is no "5.10.1, republished" override. Instead, ship the fix with the next scheduled
release. Run an ordinary `yarn release` / `publish.yml` dispatch (a code-only release is fine), and the client
fix goes out at that version alongside everything else. If this constraint becomes a real bottleneck (a
client-only bug that cannot wait), revisit the sync decision before reaching for a workaround.

### Local receipt — before touching the pipeline or provisioning anything

```bash
yarn compile
node packages/mailwoman/out/cli/index.js clients generate
```

The command emits all 8 OpenAPI documents, generates the Python package, and assembles the Rust crate. It
then verifies that both build (`uv build` + a wheel import-check; `cargo check --examples`). This is the same
7-check pipeline that the `clients` CI job replays on every dispatch. Output lands under the gitignored
`clients-build/`, and no output it produces is committed. `--skip-verify` exists for a faster template-only
loop, but never use it to validate a real change, because verification is the purpose of the command.

## What's not automated yet

- **Weights publish from CI.** The `neural-weights-*` npm publish is local-only, because the binaries are not
  on the runner. A future step could have CI fetch them from Hugging Face before publishing, as the demo
  already does at runtime.
- **`mailwoman release hf` is still run by hand.** Staging the model to HF (and bumping `releases.json`) is a
  separate manual command after the npm release and is not part of `yarn release`.
- **Client-package first publish.** Provisioning is done (see "Client packages" above: `pypi` + `cargo`
  environments, with the Trusted Publisher now bound to `publish-clients.yml`). The first PyPI publish is done
  (`mailwoman-client` 6.0.0 is live through Trusted Publishing). crates.io publishes through
  `publish-clients.yml` (the `cargo` job) once the account email is verified.
- **Changelog generation.** release-it can emit one through the `@release-it/conventional-changelog` plugin. It is not configured yet, because commit messages have not standardized on Conventional Commits.

## Recovering from a partial release

If a release fails partway through publishing:

- The git commit + tag are already created by release-it.
- `yarn npm publish --tolerate-republish` (used by `mwops release publish-workspace`) makes re-publishing already-published versions a no-op.
- Fix the underlying issue, then resume by invoking the publish script directly for each remaining workspace:

  ```bash
  for ws in <remaining workspaces>; do
    RELEASE_IT_WORKSPACES_TAG=latest \
    RELEASE_IT_WORKSPACES_ACCESS=public \
    RELEASE_IT_WORKSPACES_OTP=<otp-if-needed> \
    yarn mwops release publish-workspace --workspace ./$ws --plan release-plan.json || break
  done
  ```

  npm 2FA OTPs expire in ~30s, so run the loop promptly. A single OTP can cover all remaining workspaces.
