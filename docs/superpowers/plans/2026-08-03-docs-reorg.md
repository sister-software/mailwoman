# Docs Reorganization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ~400-page docs site with a fresh ~85-page three-audience site (Ory-style top level), plus the CLI commands that make every documented path true.

**Architecture:** One Docusaurus instance; six top-nav doors (Product, Solutions, Resources, Developers, About, Pricing) with the existing DocsSubHeader as per-door sub-nav. Internal material moves out of the published content root entirely. A new `mailwoman data` command group closes the download gap; tutorials are executed before they ship. Vale + a rewritten structure gate enforce the house style mechanically.

**Tech Stack:** Docusaurus 3 (`docs/`), Pastel/Ink CLI (`mailwoman/commands/`), Vale (vendored binary via `@vvago/vale`), vitest, zx.

**Spec:** `docs/superpowers/specs/2026-08-03-docs-reorg-design.md` — read it first; its Decisions and Register-rules sections bind every task.

## Global Constraints

- Every commit leaves `yarn workspace @mailwoman/docs build` green (broken links/anchors throw).
- Every published page declares `role:` ∈ {tutorial, guide, reference, explanation, landing, evidence}; tutorials/guides also `verified-with:`; reference also `source-of-truth:`; landing/solutions also `audience:`.
- Register rules (spec §Register): no rude or abrasive material anywhere; no named call-outs or accusations of any person or organization; named individuals never appear in comparative or strategic material; competitor prices only with dated public citations; another vendor's customers are never quoted; public-service benchmarks (BAN/Addok) framed as complementary, never adversarial; business and personal details not already published stay unpublished. Data-refresh cadence: state "no cadence committed."
- Voice per role (spec §Writing system): colleague voice in tutorials/guides; controlled STE100-derived register in reference; analog-first narrative in explanations; every number sourced.
- No redirects. No rewriting `docs/research/` (Field notes). Demo pipeline untouched except links.
- Banned-word list and a machine-writing-tells audit apply to every page before commit. Voice authority is `docs/engineering/writing-system.md` (produced by Task 25 — the derivation from the standards draft plus the contemporary-docs comparison); where it conflicts with any older voice guidance, the writing system governs.
- CLI code follows repo conventions: `.ts` extensions on relative imports, `erasableSyntaxOnly`, no raw `process.env`/`argv` (use `@mailwoman/core/env` / Pastel options), Kysely for any DB DDL, `node mailwoman/out/cli.js` for compiled-CLI runs, `yarn compile` before test runs.
- Commits: conventional prefixes; end with the Co-Authored-By + Claude-Session trailer.

## Phase overview

```
Phase 0  toolchain: Vale + frontmatter contract + structure gate      (tasks 1–2)
Phase 1  tree surgery: internal material out, skeleton cutover        (tasks 3–5)
Phase 2  CLI: data pull, drop-in cold start, Claude skill             (tasks 6–8)
Phase 3  content, door by door, tutorials executed                    (tasks 9–22)
Phase 4  full-site audit + PR                                         (tasks 23–24)
```

Raw material note: Task 4 parks the old `articles/` tree at `docs/records/site-2026-08/` (unpublished) so Phase 3 writers can mine it without archaeology. It stays there — the repo keeps its own history browsable.

---

### Task 1: Vale toolchain

**Files:**
- Create: `docs/.vale.ini`, `docs/styles/Mailwoman/*.yml` (rule files below), `docs/styles/config/vocabularies/Mailwoman/accept.txt`
- Modify: `docs/package.json` (devDependency `@vvago/vale`, script `lint:prose`), `.github/workflows/docs-build.yml` (prose-lint step in the PR job)
- Test: fixture files under `docs/scripts/vale-fixtures/`

**Interfaces:**
- Produces: `yarn workspace @mailwoman/docs lint:prose [glob]` — exits non-zero on any error-severity hit. Phase 3 tasks run it per page; Task 23 runs it corpus-wide.

- [ ] **Step 1: Install the vendored binary.** `yarn workspace @mailwoman/docs add -D @vvago/vale`, script `"lint:prose": "vale --config .vale.ini articles src/pages"`. Verify `yarn workspace @mailwoman/docs exec vale --version` prints a version (binary ships per-platform; if the package fails on the lab host, fall back to `docs/scripts/fetch-vale.ts` pinning a release tarball into `docs/.bin/` — document whichever path lands in the file header).
- [ ] **Step 2: Write `.vale.ini`.**

```ini
StylesPath = styles
MinAlertLevel = warning
Vocab = Mailwoman

[*.{md,mdx}]
BasedOnStyles = Mailwoman
# MDX: skip imports/JSX blocks
TokenIgnores = (import .+ from .+), (<[A-Z][^>]*>)
BlockIgnores = (?s)(```.*?```), (?s)(<details>.*?</details>)
```

- [ ] **Step 3: Write the rule files.** Each is a Vale `existence`/`substitution` rule; severities: banned words = error, weasel quantities = warning, anthropomorphism = warning.
  - `Mailwoman/BannedWords.yml` (error): actually, basically, simply, obviously, clearly, just (softener caught as ` just `), robust, seamless(ly), comprehensive, various, numerous, leverage, plethora, myriad, delve, crucial, pivotal, vibrant, elevate, unlock, harness, foster, facilitate, honest(ly), genuine(ly), truly, effortlessly, cleanly, quietly.
  - `Mailwoman/StockPhrases.yml` (error): "not just", "it's not just", "more than just", "isn't just", "less about .* more about", "here's the thing", "the uncomfortable truth", "what most people miss", "belt and suspenders", "load-bearing", "blast radius", "escape hatch", "north star", "first-class citizen", "source of truth" (prose only — `source-of-truth:` frontmatter is ignored via TokenIgnores addition `(^source-of-truth:.*)`).
  - `Mailwoman/Anthropomorphism.yml` (warning): "(parser|model|decoder|resolver|pipeline) (thinks|believes|wants|knows|decides to|tries to|gives up)". Suggested fixes in the rule message ("assigns", "scores", "returns").
  - `Mailwoman/Weasel.yml` (warning): nearby, fairly, usually, often, many, a lot of, significant(ly) — message: "state the measured quantity or mark the sentence deliberately qualitative."
  - `Mailwoman/Terms.yml` (substitution, error): `zip code|zipcode → ZIP Code`, `whos on first|Who's on First → Who's On First`, `geo-code → geocode`, `lat/long|lat-long → latitude/longitude`, `postal code → postcode` (en-GB house term; ZIP Code stays for the US pages by vocabulary accept-list).
- [ ] **Step 4: Fixture test.** `docs/scripts/vale-fixtures/dirty.md` containing one violation per rule; `clean.md` with compliant prose. Run `vale` on both: dirty must report ≥5 errors, clean must exit 0. Wire as `docs/scripts/check-vale-rules.sh` (three lines: run on dirty expecting failure, run on clean expecting success) and call it from the docs CI job.
- [ ] **Step 5: CI wiring.** In `docs-build.yml` PR path-filtered job, add step "Prose lint" running `yarn workspace @mailwoman/docs lint:prose` after install, before build. (Corpus is old prose until Phase 3 — scope the step to `git diff --name-only origin/main... -- 'docs/articles/**/*.md*'` changed files until Task 23 flips it to full-corpus.)
- [ ] **Step 6: Commit** `feat(docs): Vale prose toolchain with Mailwoman style rules`.

### Task 2: Frontmatter contract + structure gate rewrite

**Files:**
- Modify: `docs/scripts/check-docs-structure.ts` (full rewrite of the role logic; keep orphan + duplicate-title checks), `docs/scripts/docs-structure-allowlist.ts`
- Test: `docs/scripts/check-docs-structure.test.ts` (new, vitest — pure functions over fixture frontmatter)

**Interfaces:**
- Produces: gate requiring on EVERY published page: `role` ∈ the six-role enum; `verified-with` when role ∈ {tutorial, guide}; `source-of-truth` when role = reference; `audience` when role = landing. Exported pure `validatePage(frontmatter, path): string[]` for tests.

- [ ] **Step 1: Write failing tests** for `validatePage`: missing role → error; bad role value → error; tutorial without `verified-with` → error; reference without `source-of-truth` → error; landing without `audience` → error; valid page → `[]`.
- [ ] **Step 2: Rewrite the gate.** Replace the `ROLE_REQUIRED_PAGES` hardcoded-path array with every-page enforcement; keep sidebar-orphan and duplicate-title checks as-is; empty the allowlist (old entries reference pages that will be gone).
- [ ] **Step 3: Run tests** (`yarn workspace @mailwoman/docs vitest run scripts/`) → green. The full gate will fail against the OLD tree — acceptable: wire the strict mode behind `--strict` flag; CI keeps legacy mode until Task 5 flips `docs-build.yml` to `--strict`.
- [ ] **Step 4: Commit** `feat(docs): every-page frontmatter contract in the structure gate`.

### Task 25: Writing-system derivation (execution order: after Task 2, before Task 5)

**Files:**
- Create: `docs/engineering/writing-system.md` (the binding style source + the comparison record), `docs/engineering/page-templates/{tutorial,how-to,reference,explanation,landing,evidence}.md`
- Modify: `docs/styles/Mailwoman/*.yml` (rules updated to match the derived system), `scratchpad/writing-standards-draft.md` is INPUT ONLY (never committed — scratchpad is git-ignored)

**Interfaces:**
- Consumes: Task 1's Vale toolchain.
- Produces: the voice authority every Phase 3 task drafts against, and the updated Vale rules that mechanically enforce it. Phase 3 dispatches carry `docs/engineering/writing-system.md` + the relevant template as required reading.

- [ ] **Step 1: Field survey.** For each contemporary — Google Maps Platform (developers.google.com/maps), Mapbox (docs.mapbox.com), Geocode.earth (geocode.earth + their docs), Jawg (jawg.io docs), Felt (felt.com/docs, felt.com blog) — capture against a fixed rubric: document types offered; register per type (second person? contractions? humor?); sentence length norms; how errors/limits are admitted; terminology discipline (one term per concept?); code-example conventions; what makes their docs pleasant or painful. Record concrete quoted examples (short, cited by URL) in the comparison record.
- [ ] **Step 2: Selection matrix.** For each standards-draft entry (STE100, Diátaxis, ISO 19100, UPU S42, RFC 7322, Microsoft, Google style, OS, USBGN): adopt / adapt / reject, each with a one-sentence justification grounded in the field survey or the codebase's existing contract vocabulary. The matrix lives in `writing-system.md`.
- [ ] **Step 3: Write the system.** Voice rules per Diátaxis role (register, person, tense, example discipline), terminology policy (canonical-term table seeded from the codebase + adopted standards), number/measurement policy, the banned-pattern list (superset of Task 1's rules), and the machine-writing-tells audit checklist writers run before commit.
- [ ] **Step 4: Sync Vale.** Update rule files to match the derived system exactly (add/remove terms; severities). Fixture check (`check-vale-rules.sh`) updated + green.
- [ ] **Step 5: Templates.** One per role: frontmatter skeleton, section order, opening-move guidance, and a short exemplar paragraph written in the derived voice.
- [ ] **Step 6: Commit** `docs(engineering): derived writing system + templates; Vale rules synced`.

### Task 3: Move active internal contracts to `docs/engineering/`

**Files:**
- Move (git mv, content untouched — these are internal, not part of the rewrite): `docs/articles/plan/SCOPE.mdx`, `docs/articles/plan/CONTRIBUTING_MODEL_WORK.mdx`, all of `docs/articles/plan/reference/`, the two active design notes listed in the `reference` sidebar → `docs/engineering/` (flatten: `docs/engineering/SCOPE.mdx`, `docs/engineering/reference/…`)
- Modify: `AGENTS.md` (five path references), `docs/scripts/check-docs-structure.ts` sidebar references if any, every in-repo referrer found by grep

**Interfaces:**
- Produces: `docs/engineering/` — unpublished internal tree. AGENTS.md pointers valid.

- [ ] **Step 1:** `git mv` the files. `grep -rn "articles/plan" --include="*.{ts,tsx,md,mdx,yml,json}" .` (repo root, excluding `docs/records`, `docs/build`, `node_modules`) and fix every hit: AGENTS.md, workflow path filters, sidebars (removal happens in Task 5 — for now delete the moved ids from `sidebars.ts` `reference`/`contribute`/`archive` lists so the build stays green), any code imports of `eval-ledger.schema.json` (it lives in `plan/reference/` — keep its new path wired).
- [ ] **Step 2:** `yarn workspace @mailwoman/docs build` → green. `mailwoman eval gate --help` smoke (ledger schema path) → green.
- [ ] **Step 3: Commit** `refactor(docs): move active internal contracts out of the published tree`.

### Task 4: Park raw records; retire path-shaped exclusions

**Files:**
- Move: `docs/articles/evals/` → `docs/records/evals/`; `docs/articles/retrospectives/` → `docs/records/retrospectives/`; `docs/articles/reviews/` → `docs/records/reviews/`; `docs/articles/plan/` (remainder: phases, dated plans, superseded reference) → `docs/records/plan/`
- Modify: `docs/docusaurus.config.ts` — delete the `exclude` globs for `reviews/**` and eval postmortems (nothing internal remains under `articles/`), `docs/sidebars.ts` + `docs/src/components/DocsSubHeader/sections.ts` — drop the `archive`, `evals`, `retrospectives` sections (two files, same commit)

**Interfaces:**
- Produces: `docs/records/` — unpublished, greppable raw material for Phase 3. `articles/` contains only pages intended for the public site.

- [ ] **Step 1:** git mv the four trees; delete the exclusion globs; drop the three retired sidebar sections from both coupled files.
- [ ] **Step 2: Publicness proof.** `yarn workspace @mailwoman/docs build && grep -rl "night-shift\|postmortem" docs/build/docs | wc -l` → 0. Also `ls docs/build/docs | grep -ci retrospect` → 0.
- [ ] **Step 3: Commit** `refactor(docs): park raw records outside the content root; retire path-shaped exclusions`.

### Task 5: Skeleton cutover — new nav, front page, first pages, old tree parked

**Files:**
- Move: remaining `docs/articles/` (understanding, concepts, recipes, root pages, licensing) → `docs/records/site-2026-08/`
- Create: new `docs/articles/` skeleton: `developers/get-started/{what-mailwoman-is,install-and-first-parse,ten-minute-trial}.mdx`, `developers/status.mdx`, `developers/support.mdx`, `about/{mission,security-and-compliance,contact}.mdx`, `pricing.mdx`
- Modify: `docs/sidebars.ts` (six new sidebar ids: product, solutions, resources, developers, about, pricing), `docs/src/components/DocsSubHeader/sections.ts` (same ids, same order), `docs/docusaurus.config.ts` (navbar: six doors + Demo CTA + GitHub; footer rebuild), `docs/src/pages/index.tsx` (front page: three-audience fork — rewrite copy, keep component techniques), `.github/workflows/docs-build.yml` (structure gate → `--strict`)

**Interfaces:**
- Produces: the six-door frame every Phase 3 task hangs pages on. Sidebar ids: `product`, `solutions`, `resources`, `developers`, `about`, `pricing` — Phase 3 tasks add doc ids to these lists.

- [ ] **Step 1:** Park the old tree under `docs/records/site-2026-08/`.
- [ ] **Step 2:** Write the nine seed pages (real content, not stubs — these are the Get-started trio, Status, Support, About trio, Pricing; briefs in Tasks 9/22; write them to final quality now, they are the minimum viable site). Colleague voice; frontmatter per contract; every claim checked against `mailwoman/` source or `package.json` versions.
- [ ] **Step 3:** Rebuild nav: sidebars + sections + navbar + footer + front page. Front page fork: "Build with it" → Get started · "Make the case for it" → Solutions · "See the proof" → Benchmarks. Demo button prominent.
- [ ] **Step 4:** `yarn workspace @mailwoman/docs build` green; structure gate `--strict` green; `yarn workspace @mailwoman/docs lint:prose` green on the new pages. Screenshot via run-docs skill; eyeball nav and front page.
- [ ] **Step 5: Commit** `feat(docs)!: six-door site skeleton; old tree parked under records`.

### Task 6: `mailwoman data` command group

**Files:**
- Create: `mailwoman/data-bundles.ts` (pure bundle→artifact logic), `mailwoman/commands/data/{pull,status}.tsx`, `mailwoman/test/data-bundles.test.ts`
- Modify: `mailwoman/doctor/checks.ts` (fix hints point at `mailwoman data pull …`), `mailwoman/doctor/checks.test.ts`

**Interfaces:**
- Consumes: `readReleaseManifest`/`resolveShardPath` (`mailwoman/data-release.ts`), `dataRootPath`/`mailwomanDataRoot` (`@mailwoman/core/utils`), `sha/md5File` (`core/utils/hash.ts`), `swapDatabaseIntoPlace` (`core/utils/sealed-db.ts`), `APIClient` (`@mailwoman/core/api`) for the manifest fetch + downloads (binary path: `responseType: "arraybuffer"` streaming variant — follow `bdc/sdk/client.ts`; for multi-GB artifacts stream raw `fetch` to disk per the AGENTS.md file-transfer carve-out and say so in the header).
- Produces: `mailwoman data pull <bundle…>` and `mailwoman data status`. Bundle registry: `BUNDLES: Record<string, DataBundle>` with `{name, description, artifacts: Array<{remotePath, localPath (data-root-relative), md5Sidecar: boolean, approxBytes}>}`. Tutorials reference bundles by these names: `candidate` (global admin candidate.db), `us` (address-points + interpolation shards), `fr`, `poi`, `timezone`. Enumerate the real remote paths from the R2 bucket (`rclone ls` with `RCLONE_S3_PUBLIC_*` from `.env`, or the public HTTPS manifest) before coding — do not invent paths.

- [ ] **Step 1:** Survey what's published: `source .env && rclone ls public:… | head -100` (or curl the public bucket listing). Record the artifact inventory in the module docstring with byte sizes.
- [ ] **Step 2: Failing tests** for the pure parts: bundle resolution (`resolveBundleArtifacts(bundle, manifest)` maps versioned names), verification decision (`needsDownload(localState, remote)` — absent → yes; md5 mismatch → yes; match → no), and doctor fix-hint text (`data pull candidate` replaces the curl line).
- [ ] **Step 3:** Implement pure module → tests green.
- [ ] **Step 4:** Implement the commands (Pastel, `useCommandTask`/`CheckList` per `mailwoman/cli-kit`): download to `<dataRoot>/tmp/`, verify md5 sidecar, atomic move into place, `--dry-run` prints the plan. `data status` renders present/missing/stale per bundle (reuse doctor observation helpers).
- [ ] **Step 5:** `yarn compile && node mailwoman/out/cli.js data pull candidate --dry-run` → plan prints; run real pull into a temp `MAILWOMAN_DATA_ROOT` for the smallest bundle; verify file + md5; `data status` reports it. Doctor tests green.
- [ ] **Step 6: Commit** `feat(cli): mailwoman data pull/status — the consumer download path`.

### Task 7: Drop-in cold-start truth

**Files:**
- Modify (as findings dictate): `photon/cli.ts`, `nominatim/cli.ts`, `libpostal/cli.ts`, their READMEs
- Test: `mailwoman/test/dropin-cold-start.test.ts` (spawns each compiled CLI against a temp data root)

**Interfaces:**
- Consumes: Task 6's `data pull`.
- Produces: each of the three serves starts cold from exactly the command sequence the docs will print, or exits with a doctor-grade message naming the `data pull` fix. The verified sequences (recorded in the test) are the contract Tasks 10–11 document.

- [ ] **Step 1:** In a temp `MAILWOMAN_DATA_ROOT`, run each compiled serve cold; record every failure verbatim (prior cold-start testing found a crash + a phantom `--data` flag in the photon README).
- [ ] **Step 2:** Failing test encoding the desired behavior: with no data → exit non-zero, stderr contains `mailwoman data pull`; after `data pull candidate` (+ whatever the engine floor needs) → HTTP 200 on the health route within 30 s.
- [ ] **Step 3:** Fix the CLIs (guard missing artifacts with the doctor-style hint; align or implement the README flags), READMEs match reality.
- [ ] **Step 4:** Tests green (`yarn compile` first). **Commit** `fix(dropins): cold-start paths match the documented commands`.

### Task 8: Claude Code skill + `mailwoman skill install`

**Files:**
- Create: `mailwoman/skills/mailwoman/SKILL.md`, `mailwoman/commands/skill/install.tsx`
- Modify: `mailwoman/package.json` (`files` += `skills/`)
- Test: `mailwoman/test/skill-install.test.ts`

**Interfaces:**
- Produces: `mailwoman skill install [--dest <dir>]` copies the packaged skill into `./.claude/skills/mailwoman/`. The SKILL.md teaches an agent: parse/geocode entry points, `mailwoman doctor` first on any failure, `data pull` for missing artifacts, the component-tag vocabulary pointer, "confidence is calibrated — trust the number", and the bug-report recipe (`mailwoman parse --trace`).
- [ ] Steps: failing test (run install in temp cwd → file exists, second run idempotent) → SKILL.md content (≤150 lines, imperative, references only shipped commands) → command → tests green → **Commit** `feat(cli): ship a Claude Code skill and its installer`.

### Task 9: Get-started trio verified cold + the 10-minute trial

**Files:**
- Modify: the three `developers/get-started/*.mdx` pages from Task 5
- Create: `docs/scripts/verify-get-started.sh` (the cold-trial harness)

- [ ] **Step 1:** Cold trial per the standalone-install probe pattern: `yarn compile`, `npm pack` the `mailwoman` + weights workspaces into a temp dir OUTSIDE the repo, `npm install` the tarballs, then run the pages' commands verbatim (first parse, first geocode via `data pull candidate`). Fix pages (or product) until the transcript matches the prose. Record versions into `verified-with:`.
- [ ] **Step 2:** Encode as `verify-get-started.sh` so Task 23 re-runs it. **Commit** `docs(developers): get-started trio, verified cold`.

### Task 10: Tutorials 1–4 (parse · geocode · CSV · API server)

**Files:** Create `developers/tutorials/{first-parse,first-geocode,geocode-a-csv,run-the-api-server}.mdx`; sidebar additions.

Per-page briefs (each: colleague voice, starts-and-destinations opener, every command executed, output pasted from the real run, `verified-with` stamped):
- *first-parse* — Node, `createRuntimePipeline` (the recommended entry — not `NeuralAddressClassifier`), one messy input, walk the `AddressTree` output, confidence meaning, link to schema reference.
- *first-geocode* — `data pull candidate`, geocode the same address, coordinates + attribution, "how close is close enough" link.
- *geocode-a-csv* — the operator's own example scenario; a 20-row sample CSV committed under `docs/static/examples/`; loop with the library, then the same via CLI; malformed-row handling shown from the real output.
- *run-the-api-server* — `mailwoman serve`, health route, one curl parse + one geocode, OpenAPI pointer, where the drop-ins fit.
- [ ] Draft all four → run every example → Vale + de-slop pass → build green → **Commit** `docs(tutorials): parse, geocode, CSV, API server — executed`.

### Task 11: Tutorials 5–6 (drop-in swap · browser)

**Files:** Create `developers/tutorials/{swap-in-for-nominatim,parse-in-the-browser}.mdx`.
- *swap-in* — the Task 7 verified sequence: install, `data pull`, `mailwoman-photon serve` (photon primary; nominatim/libpostal variants as tabs), point an existing client (geopy example pointed at localhost — the survey's universal-Python-path recipe), caveats table (what the drop-in does/doesn't honor, from each README).
- *browser* — `@mailwoman/neural-web` + WASM resolver against the published R2 artifacts; the demo page is the worked proof; cold-load budget stated as measured.
- [ ] Same pipeline as Task 10. **Commit** `docs(tutorials): drop-in swap and browser — executed`.

### Task 12: Tutorials 7–8 (US dataset build · full planet)

**Files:** Create `developers/tutorials/{build-the-us-dataset,full-planet-build}.mdx`.
- Content from the real command surface (`gazetteer build …`, `tiger`, `situs`, `wof` command groups — enumerate with `--help` and the poi-layer runbook now at `docs/engineering/`). Prerequisites (disk, RAM, source downloads), staged fixtures→smoke→full ladder, expected artifacts + `data status` verification, measured durations/footprints from the lab run (numbers in the page, per the measurement corollary).
- [ ] Execute the US path end-to-end on the lab host (existing `$MAILWOMAN_DATA_ROOT` sources may seed the raw downloads; the *commands in the page* run as written). Planet page: execute the incremental deltas beyond US (document per-region loop); where a step is operator-gated (R2 creds), the page says so plainly.
- [ ] **Commit** `docs(tutorials): US dataset and planet builds — executed with measured numbers`.

### Task 13: How-to wave 1 (integration surface)

**Files:** Create `developers/how-to/{batch-geocoding,validate-addresses,handle-messy-input,autocomplete,reverse-geocode,use-annotations,tune-confidence}.mdx`.
- Briefs: batch (CPU note from the batch-path memory: session.run blocks the JS thread — worker pool pattern shown); validate (parse-confidence + codex checks, NOT deliverability claims); messy-input (normalize stage, lowercase register note); autocomplete (`autocomplete` command + library path); reverse (`reverse` + the WOFReverseGeocoder); annotations (`toOpenCage()`/`toNative()`); confidence (calibration story, thresholds by use).
- [ ] Every snippet executed against compiled CLI/library. Vale + de-slop. **Commit** `docs(how-to): integration wave`.

### Task 14: How-to wave 2 (operations surface)

**Files:** Create `developers/how-to/{keep-data-fresh,deploy-serverless,deploy-docker,mcp-server,claude-code-skill,record-matching,po-boxes-and-edge-kinds,report-a-bug}.mdx`.
- Briefs: data-fresh (`data pull` re-run + releases.json semantics; "no cadence committed" phrasing); serverless (disk-resident SQLite story, cold-start sizes measured); docker (a verified Dockerfile under `docs/static/examples/`); mcp (`@mailwoman/mcp` stdio wiring into Claude Code/other agents); skill (Task 8 installer); record-matching (`registry` command walk on a 20-row messy sample); po-boxes (kind-classifier behavior, what resolves vs what can't); report-a-bug (`parse --trace`, what a good issue contains).
- [ ] Same pipeline. **Commit** `docs(how-to): operations wave`.

### Task 15: Reference door

**Files:** Create `developers/reference/{library-api,cli,http-apis,component-tags,packages,runtime-flags,locales-and-tiers,footprints}.mdx`; Create `docs/scripts/generate-cli-reference.ts`.
- *cli* is generated: walk `mailwoman/commands/**` Pastel modules (they export `options` zod schemas + descriptions), emit MDX tables; wire into `prebuild` beside the OpenAPI emit. `source-of-truth: generated — docs/scripts/generate-cli-reference.ts`.
- *http-apis* wraps the four existing OpenAPI emits. *component-tags* renders from the schema source (`docs/engineering/reference/SCHEMA.mdx` stays the contract; the public page derives and links). *packages* is the curated 40-workspace table (from AGENTS.md, consumer-relevant subset). *runtime-flags* from the SCOPE flag register. *locales-and-tiers* states tier-1 locales + eval gates. *footprints* carries the measured artifact sizes (30.5 MB model etc. — re-measure at head, don't copy).
- Controlled register throughout; STE100 rules; no narrative.
- [ ] Generator with a vitest snapshot test → pages → build → **Commit** `docs(reference): the eight contracts, CLI generated`.

### Task 16: Knowledge base — Postal systems shelf

**Files:** Create `developers/knowledge-base/postal/{what-is-an-address,postcodes-and-zip-codes,how-mail-gets-delivered,addressing-around-the-world,falsehoods-about-addresses,two-addresses-one-building,po-boxes-and-alternatives}.mdx`.
- Mine `docs/records/site-2026-08/understanding/` (the-problem, falsehoods) — the material is strong; the rewrite tightens, de-slops, updates examples, merges the eight falsehood pages into one page with sections (the best-of decision).
- [ ] Draft → Vale/de-slop → build → **Commit** `docs(knowledge-base): postal systems shelf`.

### Task 17: Knowledge base — Geocoding shelf

**Files:** Create `developers/knowledge-base/geocoding/{what-geocoding-is,the-two-architectures,gazetteers,how-close-is-close-enough,the-landscape,why-addresses-are-hard}.mdx`.
- *the-two-architectures* is the flagship: search-engine-with-a-map vs understand-then-look-up, written plain enough to read aloud; RAM vs disk table with sourced numbers (each engine's own docs, dated citations).
- [ ] Same pipeline. **Commit** `docs(knowledge-base): geocoding shelf`.

### Task 18: Knowledge base — Address intelligence shelf

**Files:** Create `developers/knowledge-base/address-intelligence/{how-a-model-reads-an-address,tokens-and-labels,the-gazetteer-prior,decoding-and-viterbi,calibration-and-confidence,training-and-the-corpus,what-the-model-cannot-do}.mdx`.
- Analog-first rule binds hardest here: every mechanism enters through its rule-world analog (gazetteer lookup → FST prior; hand-written pattern → learned emission; tie-break heuristics → Viterbi). Mine `records/site-2026-08/concepts/` parsing-internals set. Verify every architectural claim against `neural/` at head (CRF is CE-only — no learned transitions; fr-fr ships en-us base weights; check current truth before writing, both have memory receipts).
- [ ] Same pipeline. **Commit** `docs(knowledge-base): address intelligence shelf`.

### Task 19: Product door

**Files:** Create `product/{overview,capabilities,deployment-options,drop-in-replacements,data-products}.mdx`.
- ≤600 words each; every page hands off to a tutorial/reference; landing role; numbers earned (footprints from Task 15's measurements). Data-products rewrites `records/site-2026-08/licensing/data-products.md` catalog to consumer shape; cadence phrasing per register rule.
- [ ] Same pipeline. **Commit** `docs(product): the five landing pages`.

### Task 20: Solutions door

**Files:** Create `solutions/{cut-the-per-request-bill,own-what-you-look-up,keep-addresses-inside,fleet-reverse-geocoding,resolve-a-messy-file}.mdx`.
- The manager register: problem → what changes → proof link → try-it + pricing links (the same two, every page). The storage-rights page draws licence contrasts ONLY from published terms with dated citations, neutrally framed. Price anchors only where publicly published.
- [ ] Same pipeline. **Commit** `docs(solutions): five pains, five pages`.

### Task 21: Resources — benchmarks + compare

**Files:** Create `resources/benchmarks/{index,france-ban,belgium-panel,outdoor-poi,reading-our-numbers}.mdx`, `resources/compare/{google-maps,verification-vendors,self-hosted-nominatim,pelias-and-libpostal}.mdx`.
- Benchmarks become public evidence pages: method, n, both arms, the losses published (street-level precision; the Belgian reverse defect + its fix arc), harness links (commit the harnesses under `docs/static/benchmarks/` or link the repo paths), circularity caveats kept ("the BAN tier IS BAN"). Source material is provided by the controller at dispatch time; committed pages carry only public methods, results, and harnesses. *reading-our-numbers* explains resolve-% vs precision traps.
- Compare pages: factual tables, dated citations, each ends "run it yourself" → benchmark harness. Kind register throughout.
- Gate: no internal workflow references, no unsourced figures.
- [ ] Same pipeline. **Commit** `docs(resources): re-runnable benchmarks and comparisons`.

### Task 22: About door + Pricing final

**Files:** Finalize `about/{mission,security-and-compliance,contact}.mdx`, `pricing.mdx` (seeded in Task 5).
- *mission* — the public open-strategy: commodify the layer, the operator's VS Code argument, why AGPL + flat licence, funded-by-customers posture. Register rules absolute here.
- *security-and-compliance* — self-host boundary, what leaves the machine (nothing), SBOM, data provenance (ODbL/attribution posture), licence tiers link.
- *pricing* — the ratified three tiers ($0 AGPL / $250 mo · $2,400 yr Pro under the ~250-staff·$10M fence / Enterprise from $15k), grandfathering commitment, flat-price rationale sentence ("costs us the same"), no cadence commitment.
- [ ] Same pipeline. **Commit** `docs(about): mission, trust, pricing`.

### Task 23: Full-site audit

- [ ] **Step 1:** Flip CI prose-lint to full corpus; `lint:prose` clean over `articles/` + `src/pages/`; structure gate `--strict` green; build green.
- [ ] **Step 2:** Re-run `verify-get-started.sh` cold; re-run the drop-in cold-start test; spot-run three random how-to snippets against compiled head.
- [ ] **Step 3:** Link sweep: `grep -rn "](/docs/" docs/src docs/articles` — every absolute link resolves in `docs/build`; navbar/footer/front-page links clicked in the run-docs browser; screenshots of all six doors + front page saved and eyeballed.
- [ ] **Step 4:** Publicness sweep: `grep -rli "night-shift\|postmortem\|internal\b" docs/build/docs` → empty; run the controller-held confidential-marker greps over the built output (the controller supplies the marker list at dispatch time; it is never committed) → empty.
- [ ] **Step 5:** Fresh-eyes de-slop sweep: run the humanizer profile over the ten highest-traffic pages once more; fix hits. **Commit** `docs: full-site audit fixes`.

### Task 24: PR

- [ ] Update `docs/README.md` (dev/deploy reality, including the retired `yarn deploy` boilerplate), `docs/articles` contributing pointer, and `documentation-map` successor (the six-door map lives on the Developers landing).
- [ ] `git push -u origin worktree-docs-reorg`; `gh pr create` — title `docs!: three-audience site rebuild + data CLI`, body: the spec summary, the six doors, the CLI additions, the verification ladder results (cold-trial transcript, measured builds), the deliberate breaks (old URLs, Algolia re-crawl note), the register-rules attestation, and the standard footer. Draft until Task 23 is green, then ready-for-review.

## Self-review

- **Spec coverage:** decisions 1–7 → Tasks 5 (shape), 3–5 (publicness), 6–8 (CLI), 9–22 (content), 1–2+23 (style enforcement), 24 (PR). Acceptance bullets each map: cold trial (9, 23), executed builds (12), build/gate/Vale (23), publicness (4, 23), doors-from-front-page (5), drop-ins cold (7, 23).
- **Placeholder scan:** the R2 artifact inventory (Task 6 step 1) and measured numbers (12, 15) are deliberately gathered-at-execution measurements, not placeholders — the steps that gather them are explicit.
- **Type consistency:** `validatePage` (Task 2) used only in-gate; `DataBundle`/`resolveBundleArtifacts`/`needsDownload` names consistent across Task 6 steps; sidebar ids from Task 5 used verbatim in Phase 3 tasks.
