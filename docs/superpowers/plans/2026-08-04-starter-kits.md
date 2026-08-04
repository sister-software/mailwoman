# Starter Kits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four single-sourced starter templates, an `npm init @mailwoman` engine with four shims, generated template repos in the mailwoman org, and the CI that keeps all of it true.

**Architecture:** `templates/` in the monorepo is the only hand-edited copy; the `create` package ships rendered templates; a release job syncs them to `mailwoman/starter-*`; pack-based cold-scaffold smokes gate every change.

**Tech Stack:** Node 24+, plain `node:util` parseArgs + prompts (no framework), zx for the sync job, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-04-starter-kits-design.md` — its Decisions and Acceptance sections bind every task.

## Global Constraints

- Register rules and the writing system bind all template READMEs and printed CLI text (they are public copy; CLI help source strings are public copy — the wave-2 standing rule).
- Templates never download data at scaffold time; the next-steps print offers `mailwoman data pull` and names sizes.
- Version stamping: rendered templates pin exact published versions; no `latest`, no `workspace:*` in rendered output.
- Every commit leaves repo gates green: `yarn compile`, `yarn lint`, `yarn install --immutable`, docs build where docs change, and the new template smokes.
- Repos outside the monorepo go under the `mailwoman` GitHub org (operator directive 2026-08-04).
- Commit trailers: Co-Authored-By: Claude Fable 5 <noreply@anthropic.com> + Claude-Session link, every commit.
- First-publish of the five npm packages is OPERATOR-GATED (Trusted Publishing cannot create packages): the plan prepares everything; the blessing session is a handoff item, never automated.

## Phase overview

```
Task 1  templates/_shared + geocoder template + smoke harness
Task 2  server, browser, dropin templates (smokes included)
Task 3  @mailwoman/create engine (TDD) + rendered-template build step
Task 4  four shims + workspace/publish wiring
Task 5  monorepo CI: pack-based cold-scaffold smoke per template
Task 6  release-time repo-sync job → mailwoman/starter-* + scheduled npm-reality smoke in the generated repos
Task 7  docs integration (trial page, four tutorial links, capabilities)
Task 8  publish runbook + operator handoff (bless list, repo-creation checklist)
```

### Task 1: `templates/_shared` + the geocoder template + smoke harness

**Files:**
- Create: `templates/_shared/{data-bootstrap.md,doctor-first.mjs}`, `templates/geocoder/{package.json.tmpl,README.md.tmpl,index.mjs,smoke.sh}`, `scripts/render-template.ts` (compose _shared + kit → a rendered dir; version-stamp from a supplied version map), `scripts/render-template.test.ts`
- Test: vitest on the renderer (pure: given kit + versions → file map; assert stamping, no `workspace:*`, no `latest`), plus `templates/geocoder/smoke.sh` executed against a rendered dir with packed tarballs.

**Interfaces:**
- Produces: `renderTemplate(kit: string, versions: Record<string,string>, outDir: string)` — Tasks 2–6 consume it; smoke contract: `smoke.sh <projectDir>` exits 0 when the kit's first command produced its expected output.

- [ ] Write the renderer test (RED): stamping replaces `__MAILWOMAN_VERSION__` tokens; output contains no `workspace:` or `"latest"`; `_shared` files land composed.
- [ ] Implement renderer (GREEN). The geocoder template: `index.mjs` = the CSV-loop worked example from `geocode-a-csv.mdx` reduced to one file (candidate-default world: no env exports; doctor-first; next-steps print).
- [ ] Render + pack workspaces (`scripts/pack-workspace.ts` exists) + `npm install` tarballs in a temp dir + run `smoke.sh` — transcript in the report.
- [ ] Commit `feat(templates): shared scaffolding, geocoder kit, renderer`.

### Task 2: server, browser, dropin templates

**Files:** Create `templates/{server,browser,dropin}/...` (same shape; server carries Dockerfile+compose lifted from the deploy-docker page's corrected pair; browser = web-loader + WASM resolver minimal page with self-hosted weights layout; dropin = photon-compatible serve + a pointing-your-client snippet).
- [ ] Each kit: template + smoke (server smoke curls health; browser smoke = node-side loader check per the browser tutorial's measurement basis; dropin smoke = the Task 7 cold-start sequence).
- [ ] All three smokes green against packed tarballs (transcripts). Commit `feat(templates): server, browser, dropin kits`.

### Task 3: `@mailwoman/create` engine

**Files:** Create `create/{package.json,index.ts,cli.ts,prompts.ts,test/create.test.ts}` (new workspace; follow repo TS conventions; bin `create-mailwoman`).
- [ ] TDD: template resolution (bundled rendered templates), name validation, `--template` bypasses picker, offer-not-run data-pull print, `npm install` invocation mockable. RED → GREEN.
- [ ] Build step: `prepack` renders all four templates with the CURRENT workspace versions into `create/templates/` (consumes Task 1's renderer).
- [ ] End-to-end: pack the create package, `npm init` from the tarball in a temp dir, scaffold geocoder, run its smoke. Transcript.
- [ ] Commit `feat(create): the npm-init engine`.

### Task 4: shims + workspace wiring

**Files:** Create `create-geocoder/`, `create-server/`, `create-browser/`, `create-dropin/` (each: package.json + a bin that execs the engine with the template preselected — three lines each), root workspace list updated.
- [ ] Shim test: each bin invokes the engine with the right argument (unit) + one end-to-end via tarball for `create-geocoder`.
- [ ] Publish wiring: `files` arrays, publishConfig access public, license fields matching the dual-license convention (the es-es/it-it lesson — verify against a correctly-configured sibling).
- [ ] Commit `feat(create): four npm-init shims`.

### Task 5: monorepo CI smoke

**Files:** Modify `.github/workflows/test.yml` (or a new `templates-smoke.yml`, path-filtered on `templates/**`, `create*/**`, plus the packages the kits install).
- [ ] Job: compile → pack the involved workspaces → render → scaffold each kit → run its smoke. Four kits, one matrix.
- [ ] Prove it bites: a deliberate broken-template branch run locally (act or a temp commit reverted) — evidence in the report, not in history.
- [ ] Commit `ci(templates): cold-scaffold smoke matrix`.

### Task 6: repo sync + npm-reality canary

**Files:** Create `scripts/sync-starter-repos.ts` (zx; renders with the RELEASE version map; force-pushes each kit to `mailwoman/starter-<kit>`; asserts template flag via gh api; writes the generated banner), `.github/workflows/publish.yml` gains the post-publish sync step; each rendered repo carries `.github/workflows/smoke.yml` (weekly cron: scaffold-from-npm + smoke — the publish-reality canary).
- [ ] Repo creation is operator-gated (org admin): the script CHECKS for repo existence and reports missing ones rather than creating them — the runbook (Task 8) lists the `gh repo create mailwoman/starter-* --template` commands for the operator.
- [ ] Dry-run mode renders + diffs against the remote without pushing; the real push only in the publish workflow.
- [ ] Commit `feat(release): starter-repo sync + scheduled npm-reality smoke`.

### Task 7: docs integration

**Files:** Modify `docs/articles/developers/get-started/ten-minute-trial.mdx` (the one-liner entry, offered before the manual path), the four tutorials (skip-the-setup link each), `docs/articles/product/capabilities.mdx` (starter repos link).
- [ ] Pages re-verified per the standing rules (bare fences, executed one-liner transcript once the tarball path works); Vale/gate/build green.
- [ ] Commit `docs: starter kits join the getting-started paths`.

### Task 8: publish runbook + handoff

**Files:** Create `docs/engineering/starter-kits-runbook.md` (bless list: the five packages with the exact `npm init` mapping; the org repo-creation checklist; the sync job's creds expectations; the first-publish OIDC gap note), ledger/handoff notes.
- [ ] Commit `docs(engineering): starter-kits runbook`.

## Self-review

- Spec Decisions 1–5 → Tasks 1–2 (kits), 3–4 (engine+shims), 6 (org repos + canary), 5 (executed-before-shipped), 7 (docs). Acceptance bullets: cold-scaffold smoke (5), repos byte-match (6's dry-run diff), publish blessing (8, operator), docs (7).
- No placeholders; interfaces named; the renderer is the single composition point so kits cannot drift from _shared.
- Operator-gated steps (repo creation, first publishes) are explicitly fenced as handoffs, never automated.
