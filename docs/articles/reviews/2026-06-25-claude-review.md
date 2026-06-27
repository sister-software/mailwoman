# Mailwoman mile-marker review — 2026-06-25

**Date:** 2026-06-25 · **Scope:** full-project review at v4.15.0 — code quality, documentation, user experience, functionality, and the work it takes to flip `sister-software/mailwoman` from private to public. Produced from a six-dimension agent fan-out (architecture, code quality, documentation, UX, functionality/evals, release readiness) where every "bad" / high-severity / release-blocking finding was handed to an independent skeptic to re-run the evidence before it was allowed into this document.

---

## Verdict

The engine is ready. The front door is not.

Mailwoman the _system_ — the calibrated neural sequence labeler, the WOF/gazetteer resolver, the eval discipline, the security posture, the test suite — is production-grade, and in a few places ahead of the open-source field. The dependency graph is acyclic, TypeScript strict mode is fully engaged with almost no `any`/`@ts-ignore` bypasses, the test suite is green and honest, the promotion gates grade assembled coordinates against truth rather than flattering label-F1, and a full git-history sweep finds no leaked secret.

What is _not_ ready is the first thing a public visitor reads. Both READMEs describe a system that no longer exists. The library API the npm page documents returns an empty array when you run it verbatim. The third-party data the package bundles ships without the attribution its licenses require. None of these are engineering problems and none need a design change — they are a day or two of focused surface cleanup. The risk of going public today is that the code is good and the storefront says otherwise.

Four release-blocking findings survived adversarial verification, collapsing to three fixes — the root README is wrong in two distinct ways. All of them live in documentation, packaging, and licensing, not in the model or the architecture. That is the most encouraging shape a pre-launch review can have.

---

## Scorecard

| Dimension                         | Grade | One line                                                                                 |
| --------------------------------- | :---: | ---------------------------------------------------------------------------------------- |
| Architecture & monorepo           |  A−   | 29 workspaces, but strictly acyclic with `core` as a pure leaf hub; a couple of orphans  |
| Code quality & maintainability    |  A−   | Strict TS, near-zero TODO debt, fail-loud error handling; thin tests on the v0 solver    |
| Documentation                     |  C+   | Deep, maintained internals; a stale, partly-fictional front door                         |
| User experience (CLI / API)       |  B−   | Excellent CLI and error messages; the documented _library_ API is fiction                |
| Functionality & eval health       |  A−   | Green hygienic suite, rigorous coordinate-graded gates; the ONNX model is untested in CI |
| Release readiness — security      |  A−   | No secrets in tree or history; OIDC Trusted Publishing; provenance correctly deferred    |
| Release readiness — legal/hygiene |  C+   | Bundled libpostal/libaddressinput data is unattributed; internal artifacts are public    |

---

## 1. Architecture & monorepo structure — A−

**What's great.** The 29-workspace count looks like sprawl and isn't. Extracting the `@mailwoman/*` dependency edges from every `package.json` shows a strictly acyclic graph: `core` carries zero `@mailwoman` dependencies yet 17 workspaces depend on it, and nothing depends "up" into the user-facing root `mailwoman` app. The three resolver workspaces that look like duplication — `resolver`, `resolver-wof-sqlite`, `resolver-wof-wasm` — are a documented backend split, not three answers to the same question: `resolver` holds the backend-agnostic tree-walk and the type contract stays in `core` so the pipeline composes without a cycle, then `resolver-wof-sqlite` (FTS5/candidate-table, server-side) and `resolver-wof-wasm` (sqlite-wasm, browser) are drop-in `PlaceLookup` backends. Source lives at each workspace root with co-located `*.test.ts` and `vitest.config.ts` aliases siblings to source, so `yarn test` runs with no cross-package precompile — 152k tracked source lines stay navigable.

**Needs work.** `AGENTS.md` — the file every contributor (and soon every public reader) is told to read first — documents about 9 of the 28 workspaces and still says "six scoped workspaces." Nineteen are absent from the orientation table, several of them substantial (`resolver`, `spatial`, `tiger`, `resolver-wof-sqlite` at ~7.2k LOC). Sixteen of the nineteen at least carry their own README, so the gap is the map, not the territory.

**The orphans.** `@mailwoman/variant-aliases` is published to npm at v4.15.0 with `publishConfig.access: public` and no `private` flag, yet `git grep` finds zero source importers — its own `index.ts` documents runtime integration as a plan (issue #166) that never landed. `apps/web-demo/` is three tracked files, last touched in a May lint sweep, referenced by no doc or script and superseded by the Docusaurus `/demo`; it isn't even in the `workspaces` array. `resolver-wof-sqlite/spike/` is a private benchmark nested physically inside a published workspace. None block release; all are clutter a public reader will trip over. (The known Vite bare/subpath import cycle from `#481` still exists but is contained to a single side-effect import in `classifiers/adapter.test.ts` — acknowledged, not spreading.)

## 2. Code quality & maintainability — A−

**What's great.** This is an unusually disciplined codebase for its size. Strict mode is fully on through the shared `@sister.software/tsconfig` (`strict`, `noUncheckedIndexedAccess`, `useUnknownInCatchVariables`, `noFallthroughCasesInSwitch`, `checkJs`), and the type bypasses are rare and almost all justified: across `core/neural/resolver/resolver-wof-sqlite/mailwoman/corpus/scripts` there are 19 `as any`, 28 `: any` (the library-side ones confined to variadic-generic service plumbing; the rest in throwaway diagnostic scripts), 1 `@ts-ignore`, 2 `@ts-expect-error`, and 13 narrowly-scoped eslint-disables each carrying an inline reason. Debt markers are near-zero: 3 real TODOs, 0 FIXME, 0 HACK. Error handling honors the "fail loud" culture — `rg` for empty `catch {}` across all lib and script code returns nothing; the transactional path in `coincident-roles.ts` rolls back then rethrows, CLIs exit non-zero to stderr, and the one graceful-degrade catch (`proposal-pipeline.ts`) is documented. The largest non-generated file (`resolver-wof-sqlite/lookup.ts`, 1079 lines) is a single cohesive class with a design-rationale header, not a god-file.

**Mile-marker note.** The `haversineKm` duplication the 2026-06-23 review flagged across "~5 places" is closed. There are now two definitions: the canonical great-circle helper in `spatial/position.ts:279`, and `match/distance.ts:30`, whose docstring explicitly states it is a thin domain-typed adapter over `@mailwoman/spatial`, not a second implementation. The ~30 call sites import the canonical one. A real carry-over item, resolved.

**Needs work.** The rule-based solver family (`HashMapSolver`, `BaseSolver`, `ExclusiveCartesianSolver`, the declassifiers) has only two by-name unit tests; the central `HashMapSolver` has none and carries the lone refactor TODO. It's the v0 path and the neural route is primary, so end-to-end integration tests and the eval gates cover the behavior — a bounded gap, not untested behavior. Separately, `scripts/` is well-organized (eval, record-matcher, modal, diag clusters) but only 3 of 149 files have tests; the eval harnesses there encode promotion-gate logic that gates real model decisions, so the gate logic that matters (`promotion-gate-verdict.ts`, `eval-matrix.ts`) deserves a sanity-check test even though one-off diag scripts don't. Two files drift from prettier (`core/pipeline/types.ts`, `resolver/vitest.config.ts`) — a symptom of the staged-scoped pre-commit hook that's bitten CI before.

## 3. Documentation — C+

This dimension has the widest spread in the project: the internals are excellent and the entry points are wrong.

**What's great.** `docs/articles/getting-started.mdx` is accurate and honest — the CLI flags match the real binary, confidence is framed as calibrated probability rather than vibes, and an "Honest caveats" section states house-number F1 of 0.79, non-Latin byte-fallback, ~60MB browser cold load, and ~8% full-parse exact match. A getting-started page that volunteers its own weak numbers is rare and trust-building. Behind it sits a deep, maintained knowledge base: the `plan/reference` set with `SCHEMA.mdx` as a genuine single source of truth (its `ComponentTag` union matches the live CLI tags), a 1,598-line glossary, and `DECISIONS.md`/`LOG.md` recording one structured entry per decision. This is the documentation maturity most projects never reach.

**Objectively bad — and a release blocker.** The root `README.md`, the GitHub landing page, describes the pre-neural Pelias-style rules engine across ~130 lines (Tokenization → Classifiers → `ExclusiveCartesianSolver` → solution masks) and never mentions the ONNX model, the gazetteer/resolver, calibration, or the live demo. Both of its code examples produce output that does not match the shipped CLI: the `debug` example shows a clean `[{venue, confidence, offset, penalty}]` array, the real command emits a verbose colored tokenization dump; the `parse` example shows the same array shape, the real command (run during this review) returns a flat `{locality, street, street_prefix, street_suffix, postcode}` map. The contribution note points at "upstream master" — the branch is `main`. This is the first artifact every visitor sees and it is non-reproducible on line one.

**Needs work.** The published Docusaurus site exposes 157 internal eval reports and 27 candid night-shift postmortems as live, navbar-linked pages, plus 12 AI-consult review transcripts as reachable URLs — internal infrastructure names (`/mnt/playpen`, Modal, HF, R2), GPU-spend notes, and the autonomous-operation narrative included. The `status.mdx` START-HERE page says the current npm version is 4.11.0; it's 4.15.0, with per-tag F1 tables quoted from the v4.4.0 gate. There is no `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, or root `CHANGELOG.md` — the most common gap in a newly-public repo, and the missing `SECURITY.md` matters most given npm Trusted Publishing plus untrusted-string parsing. (A substantial public changelog does exist as `docs/articles/releases.mdx`; it's a root `CHANGELOG.md` and a security policy that are absent.)

## 4. User experience — B−

**What's great.** The CLI is the strong half of the UX. `npx mailwoman parse "1600 Amphitheatre Parkway, Mountain View, CA 94043"` returns a correct, clean, flat component map through the real 29MB model with no first-run network download. Empty input returns `{}`, garbage returns a best-effort parse — no crash, no stack trace. The error messages are the kind you wish every tool wrote: `geocode` without a database prints "Set `$MAILWOMAN_WOF_DB` or pass `--resolve-db <path>`. Build one with `mailwoman-wof-build-slim` + `mailwoman-wof-build-fts`" — naming the env var, the flag, and the build tooling. `--help` is rich and precise per command.

**Objectively bad — and a release blocker.** The `mailwoman/README.md` "Library API" section is fiction. It documents `new AddressParser({ locale: "en-US", defaultCountry: "US" })` returning `result.components`, `result.coordinate`, `result.confidence`. But the exported `AddressParser` is the v0 rule parser; its options type has no `locale` or `defaultCountry` field, and with no classifiers wired it does nothing. Run the README's own snippet verbatim inside the repo and it returns an empty array — every documented field is `undefined`. The real programmatic entry point (`createRuntimePipeline` + `NeuralAddressClassifier.loadFromWeights` + `createWofResolver`) appears nowhere in the README. This is the exact code an npm consumer copies first; shipping it guarantees broken issue reports on day one.

**Verification corrected one claim here — worth recording.** A finding asserted that a fresh `npm i mailwoman` _cannot_ neural-parse because no manifest declares the weights package, so the documented `parse` "fails on a clean install." The skeptic refuted it: the default path wraps weight-loading in try/catch and falls back to the rule-only parser, so `parse` returns a valid (if weaker) result, and the hard "Could not resolve @mailwoman/neural-weights-en-us" error only fires on explicit `--neural`/`--resolve`/`geocode`, where the message already names the package to install. The real, smaller defect is that the degradation is _silent_ — the code's own docstring promises a stderr note and the catch block writes nothing — so a user gets quietly worse output with no signal. Document the weights co-install and actually emit the note. (This is the value of the adversarial pass: a plausible "broken install" blocker turned out to be a real but lesser UX gap.)

**Smaller polish.** `mailwoman --version` reports `0.1.0` — hardcoded in `cli.ts` — while the package is 4.15.0, which will send every bug report chasing a phantom version. Calibrated confidence, one of the project's stated differentiators, never appears in default output. The library install pulls react/ink/express/ioredis/zx as hard dependencies even for programmatic use (and react/ink are contradictorily listed in both `dependencies` and `peerDependenciesMeta.optional`). The clean-install smoke test exercises only the rule-only `--isolated` path — the one place it can't catch the weights-packaging gap. The in-browser demo, a key part of the story, is one generic-link hop from both READMEs.

## 5. Functionality, correctness & eval health — A−

**What's great.** The product works and its quality is measured honestly. `yarn ci:test:fast` is green — 2487 passed, 23 skipped, 0 failures across 234 files — and the integration suites pass (address.usa 73/73, intersection 65/65, resolver 69/69 including the newly default-on span-rescore). Test hygiene is excellent: zero `.only` (which would silently narrow CI), two hard `.skip` that are env-gated fallbacks, and 22 `.skipIf` legitimately gated on private data or weights. The eval discipline is the strongest single thing in the repo. Gate JSONs carry pre-registered floors with explicit `$revision` audit fields documenting every floor that moved and the coordinate justification for it; the gate runner treats an unfindable floor as a failure, never a skip; and the benchmark harnesses grade assembled coordinates with "no result counts as a miss" rather than raw label-F1 — the team's "verify before verdict / grade the coordinate" principle implemented in code, not just asserted in docs. The main branch is clean and coherent: the default-off resolver opts are documented features with stated rationale, not half-landed regressions, and the "NOT promoted" levers from the project's history were correctly left off.

**Needs work.** The ONNX model — the headline product — has no end-to-end coverage in CI. Every model-loading test `skipIf`-skips when `/mnt/playpen` is absent, which is everywhere CI runs, so CI proves the deterministic legs (tokenizer parity from a committed fixture, the decoder) but never tokenizer → ONNX → decoder end-to-end. A model-card bump that broke inference would pass green. Commit a tiny smoke ONNX or pull the published weights in one CI job and assert one classification unconditionally. Separately, the documented-canonical score ledger (`evals/scores-by-version.json`) and the latest parity scorecard are frozen at v4.4.0 / 2026-06-11 while the project shipped through v4.15.0 — the live audit trail migrated to per-version eval docs and gate JSONs, but `AGENTS.md` still names the frozen files as authoritative, so a contributor following it reads numbers 11 versions stale. Reproducibility is handled with integrity: `REPRODUCIBILITY.md` states plainly that the corpus and tokenizer are private snapshots and only the _run_ path (not retraining) is reproducible by outsiders — a caveat stated, not hidden.

## 6. Public-release readiness — security A−, legal/hygiene C+

**What's great.** Security hygiene is strong. A scan over 3,194 tracked files and a full git-history blob sweep found no AWS keys, private-key blocks, service tokens, or committed `.env`/`.pem`/`.key` — ever. `.gitignore` covers the credential surface. The publish pipeline uses npm Trusted Publishing over OIDC with no `NPM_TOKEN` secret anywhere, pulling weights from the public HF bucket. CI runs compile + test + a clean-install smoke. And the provenance posture is correct and documented: attestation is deferred behind `MAILWOMAN_NPM_PROVENANCE=1` because npm rejects provenance from a private source repo, with a one-line note to flip it on at go-public.

**Objectively bad — and a release blocker.** `core/data` bundles ~11MB of third-party data that `THIRD_PARTY_NOTICES.md` does not name: 30 libpostal dictionary files (MIT — attribution required) and 252 chromium-i18n / Google libaddressinput JSON files (Apache-2.0 — license + notice required on redistribution). `@mailwoman/core`'s `package.json` ships `data/**/*` in its tarball, so it _redistributes_ those bytes, and the notices file lives only under `docs/`, is referenced by no `files` array, and therefore travels in zero npm tarballs. For a public AGPL geocoder this is a concrete attribution-compliance gap, not a style nit. (The GeoNames CC-BY data is a notices-completeness item rather than an npm-redistribution one — it builds to the private corpus, not into any published tarball, and the adapter self-documents per-row provenance — but it belongs in the same fix.)

**Needs work, not blocking.** The license story is inconsistent across three files: `LICENSE.md` opens "All rights reserved" then describes a dual AGPL/commercial model and embeds the AGPL-3.0 text; `README.md` claims MIT Pelias portions that `LICENSE.md` never mentions; root `package.json` declares the bare SPDX `AGPL-3.0-only`, which can't express the dual offer; three workspaces still use the deprecated `AGPL-3.0` SPDX; and two different commercial-contact addresses appear. The internal `/mnt/playpen` mount is baked as a default into shipped server code (overridable, not a secret, but it reads as someone else's machine to an installer). Agent scaffolding (`.pi/`, `build-logs/v150-regate-runbook.sh` with operator host paths, the night-shift skills) is tracked and would ship public. And `HANDOFF-2026-06-25.md` — an internal session note leaking spend and staging state — is _not_ matched by the `.gitignore` handoff pattern, so a single `git add -A` would commit it; broaden the pattern to `HANDOFF-*.md` and delete the current one before the flip.

---

## Road to public release

Ordered by what actually blocks the flip. Effort in agent-nights.

### P0 — blockers (do before the repo goes public)

1. **Rewrite `README.md` (root / GitHub landing).** Replace the Pelias rules-engine walkthrough with the current neural framing, fix both example outputs to the real CLI shapes, link the live demo, fix "upstream master" → `main`. Mirror the already-correct `getting-started.mdx`. _~0.5 night._
2. **Fix the `mailwoman/README.md` Library API.** Replace the fictional `new AddressParser({locale,defaultCountry})` example with the real `createRuntimePipeline` + `loadFromWeights` path and the actual result shape — or ship a thin `AddressParser` facade that matches the documented ergonomics. Delete what you don't implement. _~0.5 night (delete) to ~1.5 (facade)._
3. **Complete and ship `THIRD_PARTY_NOTICES.md`.** Add libpostal (MIT), chromium-i18n / Google libaddressinput (Apache-2.0), and GeoNames (CC-BY-4.0) with license text and links, and add the notices file to the `files` array of every package that redistributes `core/data` so attribution travels with the bytes. _~0.5 night._

### P1 — fix before public, not strictly blocking

- Add `SECURITY.md` (disclosure contact), `CONTRIBUTING.md` (clone → yarn → compile → test plus the weights-symlink and bare/subpath gotchas), `CODE_OF_CONDUCT.md`, and a root `CHANGELOG.md`. _~0.5 night._
- Decide what internal docs are public: gate or curate the 157 eval reports, 27 night-shift postmortems, and 12 AI-consult transcripts; scrub `/mnt/playpen`/Modal/HF/R2 names from anything that stays. _~1 night (policy + sweep)._
- Reconcile the license trio: normalize SPDX to `AGPL-3.0-only` across all workspaces, resolve the MIT-Pelias claim, encode the dual model (`LicenseRef-Commercial`), unify the contact address. _~0.5 night._
- Emit the silent neural→rule degradation note and document the weights co-install; source `--version` from `package.json`. _~0.5 night._
- Refresh `AGENTS.md` (real workspace count + orientation table) and `status.mdx` (wire version/F1 from `model-card.json` at build); reconcile the `AGENTS.md` canonical-ledger pointer with the per-version eval docs. _~0.5 night._
- Smoke-test the neural parse path in clean-install CI, and add one unconditional ONNX inference assertion so a broken model fails CI, not a consumer. _~1 night._
- Broaden `.gitignore` to `HANDOFF-*.md`, delete the current handoff, decide on `.pi/`/`build-logs/` tracking, scrub `/mnt/playpen` defaults from shipped code. _~0.5 night._

### P2 — polish

- Resolve the orphans: wire or privatize `variant-aliases`; delete or relocate `apps/web-demo/`; move the `spike/` benchmark out of the published workspace.
- Surface per-component confidence in default output; split the CLI/server deps out of the library install; link the demo prominently from both READMEs.
- Add unit tests for `HashMapSolver`/`BaseSolver` and the eval-gate logic; fix the two prettier-drift files.
- On the flip: set `MAILWOMAN_NPM_PROVENANCE=1` so tarballs carry sigstore provenance.

~~**Total to clear P0 + P1: roughly 5–6 agent-nights.** P0 alone is a single focused night.~~ We can get this done in a single night. Agents are bad at estimating time. -- Operator.

### Cleared in the 2026-06-25 night shift

The follow-up shift cleared most of P1 + several P2 items (P0 landed in the day session: `f609dead`):

- **P1 — done:** community-health files (`SECURITY`/`CONTRIBUTING`/`CODE_OF_CONDUCT`); `CHANGELOG.md`; SPDX normalized to `AGPL-3.0-only` across all published packages (the MIT-Pelias claim was already attribution-only); `mailwoman --version` now reads `package.json`; `engines.node ≥ 22.5.1`; `AGENTS.md` orientation table refreshed (9 → 28 workspaces); `status.mdx` synced 4.11.0 → 4.15.0; `.gitignore HANDOFF-*.md`; the score-ledger v4.4.0-freeze noted in `AGENTS.md`.
- **P2 — done:** `HashMapSolver` tests (extended across the whole solver pipeline + `core/classification`/`spatial`/`codex`/`normalize` — ~130 tests on previously-0-coverage logic), which **surfaced + fixed a real bug** (`is2DBBox` returned the inverse of reality, `13e5ed6e`).
- **Also (beyond this review):** `scripts/` brought under the type checker (`yarn typecheck:scripts` + CI), the `arg()` argv-helper deduped (29 copies → one lib), and the data-root / WOF-shard-list consolidated across the 3 server routers.
- **Deferred — model-gated (need a model/training-available session to behavior-diff):** the neural-path clean-install ONNX assertion; the Python→TS ports (`jsonl-to-parquet` is also tangled — its python can't be cleanly removed, so a port would add duplication); the `mailwoman eval`/`gazetteer` command-ification.
- **Deferred — operator call:** the internal-docs public-rendering gating; the `/mnt/playpen` default in shipped code; `MAILWOMAN_NPM_PROVENANCE` (flip once the repo is public); the `variant-aliases` privatize-vs-wire decision. The other "orphans" were verified non-issues (`spike` is private + doesn't ship; `apps/web-demo` is stray non-workspace files).

---

## Progress since the last reviews

This is a mile marker, so measure it. The 2026-06-10 deep-dive named four operational weaknesses; three are now closed — the reproducibility crater is documented honestly in `REPRODUCIBILITY.md`, the promotion gates are consolidated and rigorous, and the `CONTRIBUTING_MODEL_WORK` runbook exists. The stale-entry-points problem it flagged is the one that persists, now sharper: the READMEs didn't just drift, they describe the wrong architecture. The 2026-06-23 review's open items have largely landed: AU word-order shipped in v4.14.0 (G-NAF, @25km 65→87), span-rescore v2 is merged and default-on, and the `haversineKm` duplication is consolidated. The strategic picture it drew — competitive in Europe, honest about the centroid-vs-rooftop gap — still holds at v4.15.0.

The trajectory is consistent: the model and the eval machinery get better every cycle, and the public-facing surface lags because nobody outside the team has needed it yet. Going public is exactly the event that makes that surface matter.

## Bottom line

Mailwoman is a strong, disciplined system with a weak storefront. The blockers are a stale root README, a fictional library-API example, and an incomplete attribution file — all fixable in a single focused night, none touching the engine. Clear P0, work through P1, and the public flip stops being a risk and becomes what it should be: a good piece of engineering finally getting to introduce itself correctly.

Fix the front door before the launch. It is the cheapest work left and the most visible.
