# async-init Migration Implementation Plan

> **For agentic workers:** required sub-skill: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Point mailwoman at the published `async-init@1.0.0` package and delete the superseded (and defective) `core/lifecycle/` module.

**Architecture:** Two consumer call-sites migrate (`core/scripting/utils/index.ts`, `core/api/APIClient.ts`), the module and its subpath exports are deleted, and the now-orphaned `lru-cache` dependency leaves `@mailwoman/core`. Spec: `docs/superpowers/specs/2026-07-18-lifecycle-ts-design.md` §Migration (package since renamed `async-init`).

**Tech Stack:** mailwoman monorepo conventions (yarn 4 workspaces, source-first TS, vitest, oxlint/oxfmt).

## Global Constraints

- **Work in an isolated git worktree** on branch `feat/async-init-migration` (operator's standing instruction; use superpowers:using-git-worktrees at execution start). Base: current `main`.
- Repo: `/home/lab/Projects/mailwoman` (worktree checkout of it). All paths relative to the worktree root.
- `async-init` is on npm at **^1.0.0** — this exact range goes in `core/package.json` `dependencies`.
- Remove the `./lifecycle` subpath from **both exports maps** in `core/package.json`: the dev map (~lines 97-100) and `publishConfig.exports` (~lines 241-243). A subpath present in only one map is a known release bug.
- `.ts` extensions on relative imports; `erasableSyntaxOnly`; acronym casing per AGENTS.md.
- The pre-commit hook runs the compiled CLI on staged files. If commits silently fail, rebuild `out/` (`yarn compile`) and verify with `git log -1`.
- Commit messages end with:

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QTpYm118V3tGk4FRhKi8Sr
```

**Established facts (verified 2026-07-19, do not re-derive):**

- Only two real consumers of `core/lifecycle/`: `core/scripting/utils/index.ts` (`ServiceRepository`) and `core/api/APIClient.ts` (`ServiceSymbol.isAsyncDisposable`). Every other repo mention of "lifecycle" is prose in comments.
- **No code in the repo ever registers a service** into `ServiceRepository`, so its registry is empty at runtime. `postScriptCleanup`'s dispose call is a forward-compatibility hook. Migrating to `defaultRegistry` preserves observable behavior exactly (an abort followed by a disposal that performs no work).
- `AsyncDisposableLRUCache` has zero consumers and is deleted with the module.
- `lru-cache` in `core/package.json` (^11.5.2, ~line 318) is used only by the deleted module. `corpus/` imports lru-cache but declares its own `^11.5.2` (verified at corpus/package.json:98), so removing core's copy is safe.
- The old `ServiceSymbol.isAsyncDisposable` used `Object.hasOwn` on the instance, so it never matched disposables implemented on the prototype. `APIClient`'s cache disposal has therefore never run. The migration makes it run. That behavior change is intended and gets a regression test.

---

### Task 1: Worktree, dependency, and APIClient migration

**Files:**

- Modify: `core/package.json` (~line 300s, `dependencies`)
- Modify: `core/api/APIClient.ts:16` and `:165`
- Create: `core/api/APIClient.test.ts`

**Interfaces:**

- Consumes: `isAsyncDisposable(input: unknown): input is AsyncDisposable` from `async-init` (chain-walking guard).
- Produces: `APIClient` whose `[Symbol.asyncDispose]` disposes prototype-implemented cache storages.

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

	// The regression case: [Symbol.asyncDispose] on the PROTOTYPE chain rather than an own property.
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

Implementer latitude: If `buildStorage`'s option or return types disagree with the sketch (axios-cache-interceptor's `AxiosStorage` shape), adapt the storage construction. The essential properties are that `[Symbol.asyncDispose]` sits on the prototype chain rather than as an own property, and that `caching.storage` type-checks. An `as never` or `as AxiosStorage` cast at the `caching:` boundary is acceptable in a test. Do not weaken the assertion.

- [ ] **Step 4: Run test to verify it fails**

Run: `yarn vitest run core/api/APIClient.test.ts` — and if the root invocation doesn't pick up core's vitest config (core has its own `vitest.config.ts` with sibling-alias rules), run it from the workspace instead: `cd core && yarn vitest run api/APIClient.test.ts`. Use whichever form works for the remaining test steps too.
Expected: fail — `disposeCount` is 0 (old predicate misses the prototype method).

- [ ] **Step 5: Migrate APIClient**

In `core/api/APIClient.ts`, replace line 16:

```ts
import { ServiceSymbol } from "../lifecycle/ServiceSymbol.ts"
```

with:

```ts
import { isAsyncDisposable } from "async-init"
```

(Import-group placement: `async-init` is a bare external import — it sorts with the other external packages at the top of the file rather than with the relative imports; let `yarn oxlint --fix`/`yarn format` settle ordering.)

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

Semantics notes (document these in the commit body rather than in code comments): `defaultRegistry.dispose()` aborts the registry's own signal before disposing, so the old timeout-path `abortController.abort(signal)` is redundant. By the time the timeout fires, the abort has already happened at dispose entry. The old `inspect()` listing of the undisposed count has no equivalent, because the new registry does not expose its contents, so it is dropped. The error line is enough. The registry is empty in practice today because no code registers, so observable behavior is identical.

- [ ] **Step 3: Verify the scripting suite + types**

Run: `yarn vitest run core/scripting 2>/dev/null || yarn vitest run --dir core` (fall back to the core suite if scripting has no dedicated tests)
Run: `yarn workspace @mailwoman/core run check-types 2>/dev/null || yarn tsc --noEmit -p core`
Expected: green / exit 0. (Adapt the exact check-types invocation to what core's package.json offers — read its scripts.)

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
- Modify: `core/package.json` — remove `./lifecycle` from both exports maps; remove `"lru-cache": "^11.5.2"` from dependencies

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

and the `publishConfig.exports` entry (~lines 241-243):

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

Expected: no hits in source files (docs/ mentions in historical records are fine and out of scope — do not edit dated docs).

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

Expected: exit 0 without any missing-module errors that reference lifecycle.

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

Expected: pack succeeds; the grep finds no match (no lifecycle files in the tarball).

- [ ] **Step 4: Push branch + open PR**

```bash
git push -u origin feat/async-init-migration
gh pr create --title "feat(core): migrate to async-init, delete core/lifecycle" --body "..."
```

The PR body must cover: the two consumer migrations, the APIClient behavior change (cache disposal that never ran now runs) with its regression test, the deletion + both-maps exports removal, the lru-cache drop, and the BREAKING CHANGE note below. End the body with the house PR footer:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01QTpYm118V3tGk4FRhKi8Sr
```

**Do not merge.** The operator merges, per house policy.

---

## Notes for the operator (not tasks)

- **Semver:** Removing the public `./lifecycle` subpath is a breaking change for `@mailwoman/core`. The release that ships it must be a core major, or it waits for the next planned major (for example, v8). The subpath's main exports were defective (their guards never matched), so external breakage is unlikely. The version decision belongs to release time rather than to this PR.
- The historical spec and plan docs keep the `lifecycle-ts` name, while the package on npm is `async-init@1.0.0`. Dated docs are point-in-time records, so they are not renamed.

## Out of scope

- Registering actual services into `defaultRegistry`. That is future work, and today no code registers.
- Any refactor of `core/api` or `core/scripting` beyond the two call-sites.
- Docs-site updates.
