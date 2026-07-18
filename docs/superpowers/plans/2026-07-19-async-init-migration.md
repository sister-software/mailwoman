# async-init Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Point mailwoman at the published `async-init@1.0.0` package and delete the superseded (and defective) `core/lifecycle/` module.

**Architecture:** Two consumer call-sites migrate (`core/scripting/utils/index.ts`, `core/api/APIClient.ts`), the module and its subpath exports are deleted, and the now-orphaned `lru-cache` dependency leaves `@mailwoman/core`. Spec: `docs/superpowers/specs/2026-07-18-lifecycle-ts-design.md` §Migration (package since renamed `async-init`).

**Tech Stack:** mailwoman monorepo conventions (yarn 4 workspaces, source-first TS, vitest, oxlint/oxfmt).

## Global Constraints

- **Work in an isolated git worktree** on branch `feat/async-init-migration` (operator's standing instruction; use superpowers:using-git-worktrees at execution start). Base: current `main`.
- Repo: `/home/lab/Projects/mailwoman` (worktree checkout of it). All paths relative to the worktree root.
- `async-init` is on npm at **^1.0.0** — this exact range goes in `core/package.json` `dependencies`.
- **Both exports maps** in `core/package.json` must lose the `./lifecycle` subpath (dev map ~lines 97-100 AND `publishConfig.exports` ~lines 241-243) — a subpath present in only one map is the known release trap.
- `.ts` extensions on relative imports; `erasableSyntaxOnly`; acronym casing per AGENTS.md.
- Pre-commit hook runs the compiled CLI and is staged-scoped — if commits silently fail, rebuild `out/` (`yarn compile`) and verify with `git log -1`.
- Commit messages end with:

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QTpYm118V3tGk4FRhKi8Sr
```

**Established facts (verified 2026-07-19, do not re-derive):**

- Only two real consumers of `core/lifecycle/`: `core/scripting/utils/index.ts` (`ServiceRepository`) and `core/api/APIClient.ts` (`ServiceSymbol.isAsyncDisposable`). Every other repo mention of "lifecycle" is prose in comments.
- **Nothing in the repo ever registers a service** into `ServiceRepository` — its registry is empty at runtime; `postScriptCleanup`'s dispose call is a forward-compatibility hook. Migrating to `defaultRegistry` preserves observable behavior exactly (abort + no-op disposal).
- `AsyncDisposableLRUCache` has zero consumers — deleted with the module.
- `lru-cache` in `core/package.json` (^11.5.2, ~line 318) is used ONLY by the deleted module. `corpus/` imports lru-cache but declares its own `^11.5.2` (verified corpus/package.json:98) — removing core's copy is safe.
- The old `ServiceSymbol.isAsyncDisposable` used `Object.hasOwn` on the instance, so it NEVER matched prototype-implemented disposables — `APIClient`'s cache disposal has been dead code. The migration makes it live; that behavior change is intended and gets a regression test.

---

### Task 1: Worktree, dependency, and APIClient migration

**Files:**

- Modify: `core/package.json` (~line 300s, `dependencies`)
- Modify: `core/api/APIClient.ts:16` and `:165`
- Create: `core/api/APIClient.test.ts`

**Interfaces:**

- Consumes: `isAsyncDisposable(input: unknown): input is AsyncDisposable` from `async-init` (chain-walking guard).
- Produces: `APIClient` whose `[Symbol.asyncDispose]` actually disposes prototype-implemented cache storages.

- [ ] **Step 1: Create the worktree** (superpowers:using-git-worktrees), branch `feat/async-init-migration` off `main`. All subsequent steps run inside it. Run `yarn install` once to hydrate.

- [ ] **Step 2: Add the dependency**

In `core/package.json` `dependencies`, add (alphabetical position — it lands first or near-first):

```json
		"async-init": "^1.0.0",
```

Run: `yarn install`
Expected: resolves `async-init@npm:^1.0.0` from the registry, lockfile updates, exit 0.

- [ ] **Step 3: Write the failing regression test**

Create `core/api/APIClient.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { buildStorage } from "axios-cache-interceptor"
import { expect, test } from "vitest"

import { APIClient } from "./APIClient.ts"

test("APIClient disposal reaches a caching storage whose asyncDispose lives on the prototype", async () => {
	let disposeCount = 0

	// The regression case: [Symbol.asyncDispose] on the PROTOTYPE chain, not an own property.
	// The pre-migration predicate (Object.hasOwn on the instance) never matched this shape,
	// leaving cache disposal as dead code.
	const storagePrototype = {
		async [Symbol.asyncDispose](): Promise<void> {
			disposeCount += 1
		},
	}

	const storage = Object.assign(
		Object.create(storagePrototype),
		buildStorage({
			find: () => undefined,
			set: () => undefined,
			remove: () => undefined,
		})
	)

	const client = new APIClient({
		displayName: "dispose-probe",
		caching: { storage },
	})

	await client[Symbol.asyncDispose]()

	expect(disposeCount).toBe(1)
})
```

Implementer latitude: if `buildStorage`'s option or return types disagree with the sketch (axios-cache-interceptor's `AxiosStorage` shape), adapt the storage construction — the ESSENTIAL property is that `[Symbol.asyncDispose]` sits on the prototype chain, not as an own property, and that `caching.storage` type-checks (a `as never`/`as AxiosStorage` cast at the `caching:` boundary is acceptable in a test). Do not weaken the assertion.

- [ ] **Step 4: Run test to verify it fails**

Run: `yarn vitest run core/api/APIClient.test.ts` — and if the root invocation doesn't pick up core's vitest config (core has its own `vitest.config.ts` with sibling-alias rules), run it from the workspace instead: `cd core && yarn vitest run api/APIClient.test.ts`. Use whichever form works for the remaining test steps too.
Expected: FAIL — `disposeCount` is 0 (old predicate misses the prototype method).

- [ ] **Step 5: Migrate APIClient**

In `core/api/APIClient.ts`, replace line 16:

```ts
import { ServiceSymbol } from "../lifecycle/ServiceSymbol.ts"
```

with:

```ts
import { isAsyncDisposable } from "async-init"
```

(Import-group placement: `async-init` is a bare external import — it sorts with the other external packages at the top of the file, not with the relative imports; let `yarn oxlint --fix`/`yarn format` settle ordering.)

And replace line 165:

```ts
		if (ServiceSymbol.isAsyncDisposable(storedCache)) {
```

with:

```ts
		if (isAsyncDisposable(storedCache)) {
```

- [ ] **Step 6: Run test to verify it passes**

Run: `yarn vitest run core/api/APIClient.test.ts`
Expected: PASS — `disposeCount` is 1.

- [ ] **Step 7: Commit**

```bash
git add core/package.json core/api/APIClient.ts core/api/APIClient.test.ts yarn.lock
git commit -m "feat(core): adopt async-init — APIClient cache disposal now actually fires

The old ServiceSymbol.isAsyncDisposable used Object.hasOwn on the instance,
never matching prototype-implemented disposables; cache teardown was dead code."
```

(Plus the required trailer.)

---

### Task 2: Migrate postScriptCleanup

**Files:**

- Modify: `core/scripting/utils/index.ts:1-3` (imports) and `:34-54` (`postScriptCleanup`)

**Interfaces:**

- Consumes: `defaultRegistry: ServiceRegistry` from `async-init` (`dispose()` aborts the registry signal first, then LIFO-disposes).
- Produces: `postScriptCleanup(signal?, exitCode?)` with unchanged signature and exit semantics.

- [ ] **Step 1: Replace the import**

In `core/scripting/utils/index.ts`, replace:

```ts
import { ServiceRepository } from "../../lifecycle/index.ts"
```

with:

```ts
import { defaultRegistry } from "async-init"
```

(Same import-group note as Task 1: external import, formatter settles position.)

- [ ] **Step 2: Rewrite `postScriptCleanup`**

Replace the function body with:

```ts
export function postScriptCleanup(signal: NodeJS.Signals = "SIGTERM", exitCode?: number): Promise<void> {
	ConsoleLogger.debug(`\n[${signal}] Shutting down...`)

	const timeout = setTimeout(() => {
		ConsoleLogger.error("Script did not exit in a timely manner.")

		process.exit(1)
	}, 15_000)

	return defaultRegistry
		.dispose()
		.catch(logScriptError)
		.finally(() => {
			clearTimeout(timeout)
			process.exit(exitCode ?? process.exitCode ?? 0)
		})
}
```

Semantics notes (document in the commit body, not code comments): `defaultRegistry.dispose()` aborts the registry's own signal BEFORE disposing, so the old timeout-path `abortController.abort(signal)` is redundant — by the time the timeout fires, the abort already happened at dispose entry. The old `inspect()` undisposed-count listing has no equivalent (the new registry doesn't expose its contents) and is dropped; the error line suffices. The registry is empty in practice today (nothing registers), so observable behavior is identical.

- [ ] **Step 3: Verify the scripting suite + types**

Run: `yarn vitest run core/scripting 2>/dev/null || yarn vitest run --dir core` (fall back to the core suite if scripting has no dedicated tests)
Run: `yarn workspace @mailwoman/core run check-types 2>/dev/null || yarn tsc --noEmit -p core`
Expected: green / exit 0. (Adapt the exact check-types invocation to what core's package.json actually offers — read its scripts.)

- [ ] **Step 4: Commit**

```bash
git add core/scripting/utils/index.ts
git commit -m "feat(core): postScriptCleanup drains async-init's defaultRegistry

dispose() aborts the registry signal on entry, so the timeout path's manual
abort is redundant; the inspect() count listing has no equivalent and is
dropped. Nothing registers services today, so behavior is unchanged."
```

(Plus trailer.)

---

### Task 3: Delete core/lifecycle + exports + orphaned dependency

**Files:**

- Delete: `core/lifecycle/index.ts`, `core/lifecycle/services.ts`, `core/lifecycle/ServiceSymbol.ts`, `core/lifecycle/lru-cache.ts`
- Modify: `core/package.json` — remove `./lifecycle` from BOTH exports maps; remove `"lru-cache": "^11.5.2"` from dependencies

- [ ] **Step 1: Delete the module**

```bash
git rm -r core/lifecycle
```

- [ ] **Step 2: Remove the subpath from both exports maps**

In `core/package.json` delete the dev-map entry (~lines 97-100):

```json
		"./lifecycle": {
			"node": "./lifecycle/index.ts",
			"default": "./out/lifecycle/index.js",
			"types": "./out/lifecycle/index.d.ts"
		},
```

AND the `publishConfig.exports` entry (~lines 241-243):

```json
			"./lifecycle": {
				"types": "./out/lifecycle/index.d.ts",
				"default": "./out/lifecycle/index.js"
			},
```

- [ ] **Step 3: Remove the orphaned dependency**

Delete `"lru-cache": "^11.5.2",` from `core/package.json` dependencies (corpus declares its own copy — verified). Run `yarn install`; lockfile updates, exit 0.

- [ ] **Step 4: Verify zero stragglers**

```bash
grep -rn "ServiceRepository\|ServiceSymbol\|AsyncDisposableLRUCache\|ServiceMethodResolver\|lifecycle/index\|lifecycle/ServiceSymbol" --include="*.ts" . | grep -v node_modules | grep -v "/out/" | grep -v worktrees | grep -v ".claude"
```

Expected: NO hits in source files (docs/ mentions in historical records are fine and out of scope — do not edit dated docs).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(core): delete core/lifecycle — superseded by async-init

Removes the ./lifecycle subpath from both exports maps and the now-orphaned
lru-cache dependency (AsyncDisposableLRUCache had zero consumers; corpus
declares its own lru-cache).

BREAKING CHANGE: @mailwoman/core no longer exports ./lifecycle."
```

(Plus trailer.)

---

### Task 4: Clean-tree verification + PR

**Files:** none (verification only)

- [ ] **Step 1: Clean-tree rebuild** (stale `out/` masks missing references — house lesson)

```bash
yarn clean 2>/dev/null; rm -rf core/out
yarn compile
```

Expected: exit 0, no missing-module errors referencing lifecycle.

- [ ] **Step 2: Full verification battery**

```bash
yarn test
yarn lint
```

Expected: suites green, lint clean. If unrelated pre-existing failures surface, record them verbatim in the task report — do not fix unrelated code.

- [ ] **Step 3: Leaf-package probe** (house lesson: undeclared hoisted deps only surface outside the repo)

```bash
yarn workspace @mailwoman/core pack -o /tmp/claude-1000/-home-lab-Projects-mailwoman/52b1cbdf-08a6-4826-93ee-2cbe4006d58b/scratchpad/core-probe.tgz
tar -tzf /tmp/claude-1000/-home-lab-Projects-mailwoman/52b1cbdf-08a6-4826-93ee-2cbe4006d58b/scratchpad/core-probe.tgz | grep -i lifecycle
```

Expected: pack succeeds; the grep finds NOTHING (no lifecycle files in the tarball).

- [ ] **Step 4: Push branch + open PR**

```bash
git push -u origin feat/async-init-migration
gh pr create --title "feat(core): migrate to async-init, delete core/lifecycle" --body "..."
```

PR body must cover: the two consumer migrations, the APIClient dead-code-now-live behavior change + regression test, the deletion + both-maps exports removal, the lru-cache drop, and the BREAKING CHANGE note below. End the body with the house PR footer:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01QTpYm118V3tGk4FRhKi8Sr
```

**Do NOT merge** — operator merges (house policy).

---

## Notes for the operator (not tasks)

- **Semver:** removing the public `./lifecycle` subpath is breaking for `@mailwoman/core` — the release that ships this is a core major (or rides the next planned major, e.g. v8). The subpath's flagship exports were defective (guards inert), so external breakage is unlikely, but the version gate is the release-time call, not this PR's.
- The historical spec/plan docs keep the `lifecycle-ts` name; the package on npm is `async-init@1.0.0`. Dated docs are point-in-time records — not renamed.

## Out of scope

- Registering actual services into `defaultRegistry` (future work — today nothing registers).
- Any refactor of `core/api` or `core/scripting` beyond the two call-sites.
- Docs-site updates.
