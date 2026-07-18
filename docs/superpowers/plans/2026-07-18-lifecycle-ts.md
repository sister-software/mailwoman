# lifecycle-ts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `lifecycle-ts` — async construction + disposal lifecycle primitives (protocol symbols, lazy `Service<T>` handles, an optional token-based `ServiceRegistry`) — as a standalone package at `/home/lab/Projects/lifecycle-ts`.

**Architecture:** Three strictly ordered layers (protocol → handle → registry), each usable without the one above. Built on the standard `AsyncDisposable` protocol and native `AsyncDisposableStack`. Spec: `docs/superpowers/specs/2026-07-18-lifecycle-ts-design.md` (mailwoman repo).

**Tech Stack:** TypeScript 6 (source-first, node type-stripping), vitest 4, oxlint + oxfmt via `@sister.software/*` shared configs, yarn 4. Zero runtime dependencies.

## Global Constraints

- **Working directory:** `/home/lab/Projects/lifecycle-ts` — a NEW standalone git repo (NOT inside mailwoman). All paths below are relative to it.
- **Node `>=24`** (native `AsyncDisposableStack`, `await using`).
- **Zero runtime dependencies.** devDependencies only.
- **License MIT**, copyright Sister Software.
- **tsconfig:** extends `@sister.software/tsconfig` plus `erasableSyntaxOnly: true`, `isolatedDeclarations: true`, `rewriteRelativeImportExtensions: true`, `emitDeclarationOnly: false`, `composite: false`, `incremental: false`. Consequences: no `enum`, no constructor parameter properties, no decorators; every export carries an explicit type annotation; relative imports use explicit `.ts` extensions.
- **Symbols** are namespaced global registry symbols: `Symbol.for("lifecycle-ts.asyncInit")`, `Symbol.for("lifecycle-ts.disposed")`.
- **Acronym casing:** whole camelCase components (`createWOFResolver`-style) — applies to all identifiers.
- **File headers:** every source file starts with:

```ts
/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */
```

- **Commit messages** end with:

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QTpYm118V3tGk4FRhKi8Sr
```

- **Run tests with** `yarn vitest run <file>` (vitest 4; no watch mode in CI steps). Typecheck with `yarn tsc --noEmit`.

## File Structure

```
/home/lab/Projects/lifecycle-ts/
├── index.ts               # barrel — explicit re-exports of every lib module
├── lib/
│   ├── errors.ts          # LifecycleError + LifecycleErrorCode union
│   ├── protocol.ts        # symbols, LifecycleContext, AsyncInitializable, guards, init(), construct()
│   ├── service.ts         # ServiceResolver forms, isServiceConstructor, Service<T>
│   ├── proxy.ts           # ServiceProxy<T> type + proxyService()
│   ├── token.ts           # ServiceToken<T> + createToken()
│   └── registry.ts        # ServiceRegistry, InjectableConstructor, TokenInstances, defaultRegistry
├── test/
│   ├── errors.test.ts
│   ├── protocol.test.ts
│   ├── service.test.ts
│   ├── proxy.test.ts
│   ├── registry.test.ts
│   ├── injectable.test.ts
│   ├── children.test.ts
│   └── types.test-d.ts    # type-level assertions (vitest --typecheck)
├── package.json, tsconfig.json, vitest.config.ts,
├── oxlint.config.ts, oxfmt.config.ts, .yarnrc.yml, .gitignore, LICENSE.md, README.md
```

---

### Task 1: Scaffold the repo

**Files:**

- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.yarnrc.yml`, `oxlint.config.ts`, `oxfmt.config.ts`, `LICENSE.md`, `index.ts`

**Interfaces:**

- Produces: a repo where `yarn tsc --noEmit`, `yarn vitest run`, and `yarn oxlint` all run clean.

- [ ] **Step 1: Create the repo and copy template files from path-ts**

```bash
mkdir -p /home/lab/Projects/lifecycle-ts/lib /home/lab/Projects/lifecycle-ts/test
cd /home/lab/Projects/lifecycle-ts
git init -b main
cp /home/lab/Projects/path-ts/LICENSE.md .
cp /home/lab/Projects/path-ts/oxlint.config.ts .
cp /home/lab/Projects/path-ts/oxfmt.config.ts .
cp /home/lab/Projects/path-ts/.yarnrc.yml . 2>/dev/null || printf 'nodeLinker: node-modules\n' > .yarnrc.yml
cp /home/lab/Projects/path-ts/.gitignore . 2>/dev/null || printf 'node_modules/\nout/\n*.tsbuildinfo\n' > .gitignore
```

Then edit the copied `oxlint.config.ts` and `oxfmt.config.ts` headers: replace the `@file` line's `path-ts` with `lifecycle-ts` (leave the rest of each file as-is).

- [ ] **Step 2: Write `package.json`**

```json
{
	"name": "lifecycle-ts",
	"version": "0.1.0",
	"description": "Async construction and disposal lifecycle primitives — the missing symbol for constructing asynchronous things.",
	"keywords": ["lifecycle", "async", "disposable", "AsyncDisposable", "dependency-injection", "service", "registry"],
	"license": "MIT",
	"author": "Teffen Ellis <teffen@sister.software>",
	"repository": {
		"type": "git",
		"url": "git+https://github.com/sister-software/lifecycle-ts.git"
	},
	"type": "module",
	"engines": {
		"node": ">=24"
	},
	"packageManager": "yarn@4.5.1",
	"exports": {
		"./package.json": "./package.json",
		".": "./out/index.js"
	},
	"files": ["out/**/*", "README.md", "LICENSE.md"],
	"scripts": {
		"clean": "rm -rf out",
		"compile": "tsc",
		"check-types": "tsc --noEmit",
		"lint": "oxlint && oxfmt --check .",
		"format": "oxfmt .",
		"test": "vitest run",
		"test:types": "vitest run --typecheck"
	},
	"devDependencies": {
		"@sister.software/oxfmt-config": "^9.1.0",
		"@sister.software/oxlint-config": "^9.1.0",
		"@sister.software/tsconfig": "^9.0.0",
		"@types/node": "^25.9.0",
		"oxfmt": "0.56.0",
		"oxlint": "1.71.0",
		"typescript": "^6.0.3",
		"vitest": "^4.1.6"
	}
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
	"extends": "@sister.software/tsconfig",
	"compilerOptions": {
		"forceConsistentCasingInFileNames": true,
		"emitDeclarationOnly": false,
		"composite": false,
		"incremental": false,
		"erasableSyntaxOnly": true,
		"isolatedDeclarations": true,
		"rewriteRelativeImportExtensions": true
	},
	"exclude": ["./out/**/*"]
}
```

- [ ] **Step 4: Write `vitest.config.ts`**

```ts
/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		typecheck: {
			include: ["test/**/*.test-d.ts"],
		},
	},
})
```

- [ ] **Step 5: Write a placeholder `index.ts`** (real re-exports land in Task 8)

```ts
/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 *   Async construction and disposal lifecycle primitives.
 */

export {}
```

- [ ] **Step 6: Install and verify the toolchain runs clean**

```bash
cd /home/lab/Projects/lifecycle-ts
yarn install
yarn check-types
yarn vitest run --passWithNoTests
yarn oxlint
```

Expected: all exit 0 (vitest reports "no test files found" but passes).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold lifecycle-ts (yarn 4 + TS 6 + vitest 4 + sister-software configs)"
```

---

### Task 2: `lib/errors.ts` — `LifecycleError`

**Files:**

- Create: `lib/errors.ts`
- Test: `test/errors.test.ts`

**Interfaces:**

- Produces: `LifecycleErrorCode` (string-literal union + const object), `class LifecycleError extends Error { readonly code: LifecycleErrorCode }`, constructed as `new LifecycleError(code, message)`.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import { LifecycleError, LifecycleErrorCode } from "../lib/errors.ts"

describe("LifecycleError", () => {
	it("carries a code and message", () => {
		const error = new LifecycleError("E_DUPLICATE_TOKEN", "already registered")

		expect(error).toBeInstanceOf(Error)
		expect(error.name).toBe("LifecycleError")
		expect(error.code).toBe("E_DUPLICATE_TOKEN")
		expect(error.message).toBe("already registered")
	})

	it("enumerates every code in the const object", () => {
		expect(Object.values(LifecycleErrorCode).sort()).toEqual([
			"E_DEPENDENCY_CYCLE",
			"E_DISPOSED",
			"E_DUPLICATE_TOKEN",
			"E_INVALID_RESOLVER",
			"E_MISSING_DEPENDENCY",
			"E_NO_RESOLVER",
			"E_UNRESOLVED_TOKEN",
		])
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run test/errors.test.ts`
Expected: FAIL — cannot resolve `../lib/errors.ts`

- [ ] **Step 3: Write `lib/errors.ts`**

```ts
/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 *   Error type shared by every lifecycle-ts layer.
 */

/**
 * Machine-readable error codes raised by lifecycle-ts.
 */
export const LifecycleErrorCode = {
	NoResolver: "E_NO_RESOLVER",
	InvalidResolver: "E_INVALID_RESOLVER",
	DuplicateToken: "E_DUPLICATE_TOKEN",
	UnresolvedToken: "E_UNRESOLVED_TOKEN",
	MissingDependency: "E_MISSING_DEPENDENCY",
	DependencyCycle: "E_DEPENDENCY_CYCLE",
	Disposed: "E_DISPOSED",
} as const

export type LifecycleErrorCode = (typeof LifecycleErrorCode)[keyof typeof LifecycleErrorCode]

/**
 * Error raised by lifecycle-ts. Inspect {@linkcode LifecycleError.code} to branch on the cause.
 */
export class LifecycleError extends Error {
	public readonly code: LifecycleErrorCode

	constructor(code: LifecycleErrorCode, message: string) {
		super(message)

		this.name = "LifecycleError"
		this.code = code
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run test/errors.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/errors.ts test/errors.test.ts
git commit -m "feat: LifecycleError with typed code union"
```

---

### Task 3: `lib/protocol.ts` — symbols, guards, `init()`, `construct()`

**Files:**

- Create: `lib/protocol.ts`
- Test: `test/protocol.test.ts`

**Interfaces:**

- Produces:
  - `asyncInit: unique symbol`, `disposed: unique symbol`
  - `interface LifecycleContext { readonly signal: AbortSignal }`
  - `interface AsyncInitializable { [asyncInit](context?: LifecycleContext): Promise<void> }`
  - `isAsyncDisposable(input: unknown): input is AsyncDisposable` — prototype-chain-aware
  - `isAsyncInitializable(input: unknown): input is AsyncInitializable` — prototype-chain-aware
  - `isDisposed(input: object): boolean`, `markDisposed(input: object): boolean`
  - `init<T extends AsyncInitializable>(instance: T, context?: LifecycleContext): Promise<T>`
  - `construct<A extends readonly unknown[], T extends AsyncInitializable>(Ctor: new (...args: A) => T, ...args: A): Promise<T>`

- [ ] **Step 1: Write the failing test**

```ts
/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import {
	asyncInit,
	construct,
	init,
	isAsyncDisposable,
	isAsyncInitializable,
	isDisposed,
	markDisposed,
} from "../lib/protocol.ts"

/** A disposable defined via a class METHOD — lives on the prototype, not the instance. */
class PrototypeDisposable {
	public disposeCount = 0

	public async [Symbol.asyncDispose](): Promise<void> {
		this.disposeCount += 1
	}
}

/** Inheritance: the subclass has NOTHING own — everything comes from the base prototype. */
class InheritedDisposable extends PrototypeDisposable {}

class Initializable {
	public initializedWith: unknown = null

	public async [asyncInit](context?: unknown): Promise<void> {
		this.initializedWith = context ?? "no-context"
	}

	public async [Symbol.asyncDispose](): Promise<void> {}
}

describe("isAsyncDisposable", () => {
	it("walks the prototype chain", () => {
		expect(isAsyncDisposable(new PrototypeDisposable())).toBe(true)
		expect(isAsyncDisposable(new InheritedDisposable())).toBe(true)
	})

	it("accepts own-property disposables", () => {
		expect(isAsyncDisposable({ [Symbol.asyncDispose]: async () => {} })).toBe(true)
	})

	it("rejects non-disposables", () => {
		expect(isAsyncDisposable({})).toBe(false)
		expect(isAsyncDisposable(null)).toBe(false)
		expect(isAsyncDisposable(42)).toBe(false)
		expect(isAsyncDisposable({ [Symbol.asyncDispose]: "not a function" })).toBe(false)
	})
})

describe("isAsyncInitializable", () => {
	it("walks the prototype chain", () => {
		expect(isAsyncInitializable(new Initializable())).toBe(true)

		class Sub extends Initializable {}
		expect(isAsyncInitializable(new Sub())).toBe(true)
	})

	it("rejects non-initializables", () => {
		expect(isAsyncInitializable(new PrototypeDisposable())).toBe(false)
		expect(isAsyncInitializable(null)).toBe(false)
	})
})

describe("markDisposed / isDisposed", () => {
	it("round-trips: mark once, further marks refused", () => {
		const target = new PrototypeDisposable()

		expect(isDisposed(target)).toBe(false)
		expect(markDisposed(target)).toBe(true)
		expect(isDisposed(target)).toBe(true)
		expect(markDisposed(target)).toBe(false)
	})
})

describe("init", () => {
	it("awaits the symbol method and returns the instance", async () => {
		const instance = new Initializable()
		const result = await init(instance)

		expect(result).toBe(instance)
		expect(instance.initializedWith).toBe("no-context")
	})

	it("forwards the context", async () => {
		const instance = new Initializable()
		const context = { signal: new AbortController().signal }
		await init(instance, context)

		expect(instance.initializedWith).toBe(context)
	})
})

describe("construct", () => {
	it("news up and initializes in one call, preserving constructor arg types", async () => {
		// Long-form field assignment — parameter properties are forbidden by erasableSyntaxOnly.
		class WithArguments extends Initializable {
			public readonly label: string

			constructor(label: string) {
				super()
				this.label = label
			}
		}

		const instance = await construct(WithArguments, "hello")

		expect(instance.label).toBe("hello")
		expect(instance.initializedWith).toBe("no-context")
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run test/protocol.test.ts`
Expected: FAIL — cannot resolve `../lib/protocol.ts`

- [ ] **Step 3: Write `lib/protocol.ts`**

```ts
/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 *   The lifecycle protocol: symbols for asynchronous construction and disposal marking, plus
 *   prototype-chain-aware guards. Zero runtime state — usable without any other layer.
 */

/**
 * Global symbol for asynchronous construction — the async complement to `Symbol.asyncDispose`.
 *
 * Namespaced via `Symbol.for` so duplicated copies of this package agree on symbol identity.
 */
export const asyncInit: unique symbol = Symbol.for("lifecycle-ts.asyncInit")

/**
 * Global symbol marking an object as already disposed.
 */
export const disposed: unique symbol = Symbol.for("lifecycle-ts.disposed")

/**
 * Ambient state made available to services during resolution and initialization.
 */
export interface LifecycleContext {
	readonly signal: AbortSignal
}

/**
 * An object which can be further constructed asynchronously after its synchronous constructor runs.
 */
export interface AsyncInitializable {
	[asyncInit](context?: LifecycleContext): Promise<void>
}

/**
 * Type-predicate: does `input` implement `AsyncDisposable`? Walks the prototype chain.
 */
export function isAsyncDisposable(input: unknown): input is AsyncDisposable {
	if (!input || (typeof input !== "object" && typeof input !== "function")) return false

	return Symbol.asyncDispose in input && typeof (input as AsyncDisposable)[Symbol.asyncDispose] === "function"
}

/**
 * Type-predicate: does `input` implement {@linkcode AsyncInitializable}? Walks the prototype chain.
 */
export function isAsyncInitializable(input: unknown): input is AsyncInitializable {
	if (!input || (typeof input !== "object" && typeof input !== "function")) return false

	return asyncInit in input && typeof (input as AsyncInitializable)[asyncInit] === "function"
}

/**
 * Has `input` been marked disposed via {@linkcode markDisposed}?
 */
export function isDisposed(input: object): boolean {
	return disposed in input
}

/**
 * Mark `input` as disposed. Returns false — without re-marking — if it already was.
 */
export function markDisposed(input: object): boolean {
	if (disposed in input) return false

	Object.defineProperty(input, disposed, { value: true })

	return true
}

/**
 * Await `instance`'s {@linkcode asyncInit} method and return the same instance.
 */
export async function init<T extends AsyncInitializable>(instance: T, context?: LifecycleContext): Promise<T> {
	await instance[asyncInit](context)

	return instance
}

/**
 * `new` + {@linkcode init} in one call. Constructor arguments are fully typed.
 */
export async function construct<A extends readonly unknown[], T extends AsyncInitializable>(
	Ctor: new (...args: A) => T,
	...args: A
): Promise<T> {
	return init(new Ctor(...args))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run test/protocol.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/protocol.ts test/protocol.test.ts
git commit -m "feat: lifecycle protocol — asyncInit/disposed symbols, chain-aware guards, init/construct"
```

---

### Task 4: `lib/service.ts` — `Service<T>` handle

**Files:**

- Create: `lib/service.ts`
- Test: `test/service.test.ts`

**Interfaces:**

- Consumes: `LifecycleError` (Task 2); `asyncInit`, `isAsyncDisposable`, `isAsyncInitializable`, `markDisposed`, `LifecycleContext` (Task 3).
- Produces:
  - `type ServiceFactory<T extends object> = (context: LifecycleContext) => T | Promise<T>`
  - `type ServiceConstructor<T extends object> = new () => T`
  - `type ServiceResolver<T extends object> = T | ServiceFactory<T> | ServiceConstructor<T>`
  - `isServiceConstructor<T extends object>(input: unknown): input is ServiceConstructor<T>`
  - `class Service<T extends object> implements PromiseLike<T>, AsyncDisposable` with `constructor(resolver: ServiceResolver<T>, context?: LifecycleContext)`, `resolve(): Promise<T>`, `get instance(): T | null`, `then(...)`, `[Symbol.asyncDispose]()`

- [ ] **Step 1: Write the failing test**

```ts
/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import { asyncInit, isDisposed } from "../lib/protocol.ts"
import type { LifecycleContext } from "../lib/protocol.ts"
import { isServiceConstructor, Service } from "../lib/service.ts"

class Widget {
	public initContext: LifecycleContext | undefined
	public disposeCount = 0

	public async [asyncInit](context?: LifecycleContext): Promise<void> {
		this.initContext = context
	}

	public async [Symbol.asyncDispose](): Promise<void> {
		this.disposeCount += 1
	}
}

/** Subclass with NOTHING own on its prototype — the inherited-disposable trap. */
class InheritedWidget extends Widget {}

describe("isServiceConstructor", () => {
	it("accepts classes, including subclasses with empty prototypes", () => {
		expect(isServiceConstructor(Widget)).toBe(true)
		expect(isServiceConstructor(InheritedWidget)).toBe(true)
	})

	it("rejects factories and non-functions", () => {
		expect(isServiceConstructor(() => new Widget())).toBe(false)
		expect(isServiceConstructor(new Widget())).toBe(false)
		expect(isServiceConstructor(null)).toBe(false)
	})
})

describe("Service resolution", () => {
	it("resolves a pre-built instance and runs asyncInit on it", async () => {
		const widget = new Widget()
		const service = new Service(widget)

		expect(await service).toBe(widget)
		expect(widget.initContext).toBeDefined()
	})

	it("resolves a factory with context and runs asyncInit", async () => {
		const service = new Service((context: LifecycleContext) => {
			expect(context.signal).toBeInstanceOf(AbortSignal)
			return new Widget()
		})

		const widget = await service
		expect(widget.initContext).toBeDefined()
	})

	it("resolves a constructor via `new` — even an inherited-disposable subclass", async () => {
		const service = new Service(InheritedWidget)
		const widget = await service

		expect(widget).toBeInstanceOf(InheritedWidget)
		expect(widget.initContext).toBeDefined()
	})

	it("constructs exactly one instance under concurrent await", async () => {
		let constructed = 0
		const service = new Service(async () => {
			constructed += 1
			await new Promise((resolve) => setTimeout(resolve, 10))
			return new Widget()
		})

		const [a, b, c] = await Promise.all([service.resolve(), service.resolve(), service.resolve()])

		expect(constructed).toBe(1)
		expect(a).toBe(b)
		expect(b).toBe(c)
	})

	it("clears the memo on failure so a later await can retry", async () => {
		let attempts = 0
		const service = new Service(() => {
			attempts += 1
			if (attempts === 1) throw new Error("first attempt fails")
			return new Widget()
		})

		await expect(service.resolve()).rejects.toThrow("first attempt fails")
		await expect(service.resolve()).resolves.toBeInstanceOf(Widget)
		expect(attempts).toBe(2)
	})

	it("exposes the instance after resolution", async () => {
		const service = new Service(Widget)

		expect(service.instance).toBeNull()
		const widget = await service
		expect(service.instance).toBe(widget)
	})
})

describe("Service disposal", () => {
	it("disposes the resolved instance exactly once and marks it", async () => {
		const service = new Service(Widget)
		const widget = await service

		await service[Symbol.asyncDispose]()
		await service[Symbol.asyncDispose]()

		expect(widget.disposeCount).toBe(1)
		expect(isDisposed(widget)).toBe(true)
	})

	it("is a no-op when never resolved", async () => {
		let constructed = 0
		const service = new Service(() => {
			constructed += 1
			return new Widget()
		})

		await service[Symbol.asyncDispose]()
		expect(constructed).toBe(0)
	})

	it("is a no-op when resolution failed", async () => {
		const service = new Service(() => {
			throw new Error("boom")
		})

		await expect(service.resolve()).rejects.toThrow("boom")
		await expect(service[Symbol.asyncDispose]()).resolves.toBeUndefined()
	})

	it("works with await using", async () => {
		let seen: Widget | null = null

		{
			await using service = new Service(Widget)
			seen = await service
			expect(seen.disposeCount).toBe(0)
		}

		expect(seen.disposeCount).toBe(1)
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run test/service.test.ts`
Expected: FAIL — cannot resolve `../lib/service.ts`

- [ ] **Step 3: Write `lib/service.ts`**

```ts
/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 *   Service<T>: a lazy, awaitable, disposable handle around a resolver. Usable standalone —
 *   the registry layer builds on this but is never required.
 */

import { LifecycleError } from "./errors.ts"
import { asyncInit, isAsyncDisposable, isAsyncInitializable, markDisposed } from "./protocol.ts"
import type { LifecycleContext } from "./protocol.ts"

/**
 * A function which produces a service instance, optionally asynchronously.
 */
export type ServiceFactory<T extends object> = (context: LifecycleContext) => T | Promise<T>

/**
 * A zero-argument class constructor producing a service instance.
 */
export type ServiceConstructor<T extends object> = new () => T

/**
 * Anything a {@linkcode Service} can resolve: a pre-built instance, a factory, or a constructor.
 */
export type ServiceResolver<T extends object> = T | ServiceFactory<T> | ServiceConstructor<T>

/**
 * Type-predicate distinguishing class constructors from factory functions.
 *
 * Class syntax is detected via `Function.prototype.toString`; ES5-style constructors are accepted
 * when their prototype carries a lifecycle symbol (walking the chain, so inherited implementations
 * count — the `Object.hasOwn` trap this replaces crashed on exactly that case).
 */
export function isServiceConstructor<T extends object>(input: unknown): input is ServiceConstructor<T> {
	if (typeof input !== "function") return false

	const prototype: unknown = (input as { prototype?: unknown }).prototype
	if (!prototype || typeof prototype !== "object") return false

	if (Function.prototype.toString.call(input).startsWith("class")) return true

	return Symbol.asyncDispose in prototype || asyncInit in prototype
}

/**
 * A lazy, awaitable, disposable handle. Awaiting the service resolves (and memoizes) the instance;
 * disposal forwards to the instance if it resolved and is disposable.
 */
export class Service<T extends object> implements PromiseLike<T>, AsyncDisposable {
	#resolver: ServiceResolver<T>
	#context: LifecycleContext
	#promise: Promise<T> | null = null
	#instance: T | null = null

	constructor(resolver: ServiceResolver<T>, context?: LifecycleContext) {
		this.#resolver = resolver
		this.#context = context ?? { signal: new AbortController().signal }
	}

	/**
	 * The resolved instance, or null before the first successful resolution.
	 */
	public get instance(): T | null {
		return this.#instance
	}

	/**
	 * Resolve the instance. Concurrent callers share one in-flight resolution; a failed
	 * resolution clears the memo so a later call may retry.
	 */
	public resolve(): Promise<T> {
		this.#promise ??= this.#resolveUncached().then(
			(instance) => {
				this.#instance = instance

				return instance
			},
			(error: unknown) => {
				this.#promise = null

				throw error
			}
		)

		return this.#promise
	}

	async #resolveUncached(): Promise<T> {
		const resolver = this.#resolver
		let instance: T

		if (typeof resolver === "function") {
			if (isServiceConstructor<T>(resolver)) {
				instance = new resolver()
			} else {
				instance = await (resolver as ServiceFactory<T>)(this.#context)
			}
		} else if (resolver && typeof resolver === "object") {
			instance = resolver
		} else {
			throw new LifecycleError(
				"E_INVALID_RESOLVER",
				`Resolver must be an instance, factory, or constructor. Received: ${String(resolver)}`
			)
		}

		if (isAsyncInitializable(instance)) {
			await instance[asyncInit](this.#context)
		}

		return instance
	}

	/**
	 * Resolve the service. Called implicitly when the service is awaited.
	 */
	// oxlint-disable-next-line unicorn/no-thenable -- intentional: a Service is awaitable by design
	public then<TResult1 = T, TResult2 = never>(
		onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
	): Promise<TResult1 | TResult2> {
		return this.resolve().then(onfulfilled, onrejected)
	}

	public async [Symbol.asyncDispose](): Promise<void> {
		if (!this.#promise) return

		let instance: T

		try {
			instance = await this.#promise
		} catch {
			return
		}

		if (!isAsyncDisposable(instance)) return
		if (!markDisposed(instance)) return

		await instance[Symbol.asyncDispose]()
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run test/service.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/service.ts test/service.test.ts
git commit -m "feat: Service<T> — promise-memoized lazy handle, all resolver forms init with context"
```

---

### Task 5: `lib/proxy.ts` — `ServiceProxy<T>` with honest types

**Files:**

- Create: `lib/proxy.ts`
- Test: `test/proxy.test.ts`

**Interfaces:**

- Consumes: `Service<T>` (Task 4).
- Produces:
  - `type ServiceProxy<T>` — methods become `(...args) => Promise<Awaited<R>>`, non-function properties become `() => Promise<T[K]>` thunks.
  - `proxyService<T extends object>(service: Service<T>): Service<T> & ServiceProxy<T>`

- [ ] **Step 1: Write the failing test**

```ts
/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import { proxyService } from "../lib/proxy.ts"
import { Service } from "../lib/service.ts"

class Greeter {
	public planet = "world"

	public async [Symbol.asyncDispose](): Promise<void> {}

	public greet(name: string): string {
		return `hello ${name} of ${this.planet}`
	}
}

describe("proxyService", () => {
	it("forwards method calls through lazy resolution, preserving `this`", async () => {
		const proxied = proxyService(new Service(Greeter))

		await expect(proxied.greet("teffen")).resolves.toBe("hello teffen of world")
	})

	it("exposes non-function properties as thunks", async () => {
		const proxied = proxyService(new Service(Greeter))

		await expect(proxied.planet()).resolves.toBe("world")
	})

	it("keeps Service members functional through the proxy (private-field safety)", async () => {
		const proxied = proxyService(new Service(Greeter))

		// resolve() reads #promise — it must be bound to the target, not the proxy.
		const instance = await proxied.resolve()
		expect(instance).toBeInstanceOf(Greeter)
		expect(proxied.instance).toBe(instance)

		// then() — awaiting the proxy itself must work too.
		expect(await proxied).toBe(instance)
	})

	it("disposes through the proxy", async () => {
		let disposeCount = 0

		class Tracked {
			public async [Symbol.asyncDispose](): Promise<void> {
				disposeCount += 1
			}
		}

		const proxied = proxyService(new Service(Tracked))
		await proxied.resolve()
		await proxied[Symbol.asyncDispose]()

		expect(disposeCount).toBe(1)
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run test/proxy.test.ts`
Expected: FAIL — cannot resolve `../lib/proxy.ts`

- [ ] **Step 3: Write `lib/proxy.ts`**

```ts
/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 *   Method-resolving proxy over Service<T>: call instance methods before the service has
 *   resolved — the call awaits resolution first. Types are honest: non-function properties
 *   surface as explicit thunks, matching what the runtime returns.
 */

import type { Service } from "./service.ts"

/**
 * The lazy view of `T` exposed by {@linkcode proxyService}: methods return promises; plain
 * properties become zero-argument thunks returning promises.
 */
export type ServiceProxy<T> = {
	[K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : () => Promise<T[K]>
}

/**
 * Wrap a {@linkcode Service} so instance members can be invoked before resolution.
 *
 * Own `Service` members win over instance members and are bound to the unproxied target —
 * `Service` uses private fields, which throw when accessed through a proxy receiver.
 */
export function proxyService<T extends object>(service: Service<T>): Service<T> & ServiceProxy<T> {
	return new Proxy(service, {
		get(target, property) {
			if (property in target) {
				const value: unknown = Reflect.get(target, property)

				return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value
			}

			return async (...args: unknown[]): Promise<unknown> => {
				const instance = await target
				const value: unknown = Reflect.get(instance, property)

				return typeof value === "function" ? (value as (...args: unknown[]) => unknown).apply(instance, args) : value
			}
		},
	}) as Service<T> & ServiceProxy<T>
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run test/proxy.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/proxy.ts test/proxy.test.ts
git commit -m "feat: ServiceProxy — lazy method resolution with honest thunk types"
```

---

### Task 6: `lib/token.ts` + `lib/registry.ts` basics

**Files:**

- Create: `lib/token.ts`, `lib/registry.ts`
- Test: `test/registry.test.ts`

**Interfaces:**

- Consumes: `LifecycleError` (Task 2), `Service`/`ServiceResolver` (Task 4), `proxyService`/`ServiceProxy` (Task 5).
- Produces:
  - `interface ServiceToken<out T> { readonly description: string }` (phantom-branded), `createToken<T>(description: string): ServiceToken<T>`
  - `interface ServiceRegistryOptions { onWarning?: (message: string) => void }`
  - `class ServiceRegistry implements AsyncDisposable` with `register`, `get`, `signal`, `dispose()`, `[Symbol.asyncDispose]()` (Task 7 adds injectables; Task 8 adds `createChild`)
  - `defaultRegistry: ServiceRegistry`

- [ ] **Step 1: Write the failing test**

```ts
/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import { LifecycleError } from "../lib/errors.ts"
import { ServiceRegistry } from "../lib/registry.ts"
import { createToken } from "../lib/token.ts"

interface Logger {
	readonly lines: string[]
	log(line: string): void
}

const ILogger = createToken<Logger & AsyncDisposable>("logger")

function createTestLogger(onDispose?: () => void): Logger & AsyncDisposable {
	return {
		lines: [],
		log(line: string): void {
			this.lines.push(line)
		},
		async [Symbol.asyncDispose](): Promise<void> {
			onDispose?.()
		},
	}
}

describe("createToken", () => {
	it("produces frozen, identity-keyed tokens", () => {
		const token = createToken<Logger>("logger")

		expect(token.description).toBe("logger")
		expect(Object.isFrozen(token)).toBe(true)
		expect(createToken<Logger>("logger")).not.toBe(token)
	})
})

describe("ServiceRegistry", () => {
	it("registers and gets by token, typed by interface", async () => {
		await using registry = new ServiceRegistry()

		registry.register(ILogger, createTestLogger())
		const logger = await registry.get(ILogger)

		logger.log("hi")
		expect(logger.lines).toEqual(["hi"])
	})

	it("register returns the proxied handle directly", async () => {
		await using registry = new ServiceRegistry()

		const handle = registry.register(ILogger, createTestLogger())
		await handle.log("via proxy")

		expect((await handle).lines).toEqual(["via proxy"])
	})

	it("throws E_DUPLICATE_TOKEN on double registration", async () => {
		await using registry = new ServiceRegistry()
		registry.register(ILogger, createTestLogger())

		expect(() => registry.register(ILogger, createTestLogger())).toThrowError(
			expect.objectContaining({ code: "E_DUPLICATE_TOKEN" })
		)
	})

	it("throws E_UNRESOLVED_TOKEN for unknown tokens", async () => {
		await using registry = new ServiceRegistry()

		expect(() => registry.get(ILogger)).toThrowError(expect.objectContaining({ code: "E_UNRESOLVED_TOKEN" }))
	})

	it("disposes resolved services LIFO, aborting the signal first", async () => {
		const order: string[] = []
		const registry = new ServiceRegistry()

		const IFirst = createToken<AsyncDisposable>("first")
		const ISecond = createToken<AsyncDisposable>("second")

		registry.register(IFirst, {
			async [Symbol.asyncDispose]() {
				order.push("first")
			},
		})
		registry.register(ISecond, {
			async [Symbol.asyncDispose]() {
				order.push("second")
			},
		})

		await registry.get(IFirst).resolve()
		await registry.get(ISecond).resolve()

		registry.signal.addEventListener("abort", () => order.push("abort"), { once: true })
		await registry.dispose()

		expect(order).toEqual(["abort", "second", "first"])
	})

	it("disposes a resolved-but-never-awaited-by-caller service", async () => {
		let disposeCount = 0
		const registry = new ServiceRegistry()

		const handle = registry.register(
			ILogger,
			createTestLogger(() => (disposeCount += 1))
		)
		await handle.resolve()

		await registry.dispose()
		expect(disposeCount).toBe(1)
	})

	it("second dispose is a warned no-op", async () => {
		const warnings: string[] = []
		const registry = new ServiceRegistry({ onWarning: (message) => warnings.push(message) })

		await registry.dispose()
		await registry.dispose()

		expect(warnings).toHaveLength(1)
	})

	it("refuses registration after disposal", async () => {
		const registry = new ServiceRegistry()
		await registry.dispose()

		expect(() => registry.register(ILogger, createTestLogger())).toThrowError(
			expect.objectContaining({ code: "E_DISPOSED" })
		)
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run test/registry.test.ts`
Expected: FAIL — cannot resolve `../lib/registry.ts`

- [ ] **Step 3: Write `lib/token.ts`**

```ts
/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 *   Service tokens: runtime keys married to interface types. A token's type parameter is
 *   phantom — it exists only at the type level, giving full inference at registry call sites.
 */

declare const serviceTokenBrand: unique symbol

/**
 * A runtime key carrying a phantom interface type. Compared by reference identity.
 */
export interface ServiceToken<out T> {
	readonly description: string
	readonly [serviceTokenBrand]?: T
}

/**
 * Create a token binding `description` (diagnostics only — identity is by reference) to type `T`.
 */
export function createToken<T>(description: string): ServiceToken<T> {
	return Object.freeze({ description })
}
```

Declaration-emit note: `declare const serviceTokenBrand` is erased at runtime and legal in the emitted `.d.ts` as a non-exported ambient. If `tsc` under `isolatedDeclarations` rejects the unexported computed key ("has or is using private name"), export the symbol declaration (`export declare const serviceTokenBrand: unique symbol`) — behavior is identical.

- [ ] **Step 4: Write `lib/registry.ts`** (basics — no injectables, no children yet)

```ts
/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 *   ServiceRegistry: an optional, instantiable, token-keyed container over Service<T> handles.
 *   Backed by AsyncDisposableStack — LIFO disposal with SuppressedError aggregation. Disposal
 *   aborts the registry signal first so in-flight resolvers can bail.
 */

import { LifecycleError } from "./errors.ts"
import { proxyService } from "./proxy.ts"
import type { ServiceProxy } from "./proxy.ts"
import { Service } from "./service.ts"
import type { ServiceResolver } from "./service.ts"
import type { ServiceToken } from "./token.ts"

export interface ServiceRegistryOptions {
	/**
	 * The registry's only logging hook — silent by default.
	 */
	onWarning?: (message: string) => void
}

/**
 * A scoped, disposable service container. Fully optional — every service works without one.
 */
export class ServiceRegistry implements AsyncDisposable {
	#services = new Map<ServiceToken<unknown>, Service<object> & ServiceProxy<object>>()
	#stack = new AsyncDisposableStack()
	#abortController = new AbortController()
	#onWarning: ((message: string) => void) | undefined
	#disposed = false

	constructor(options?: ServiceRegistryOptions) {
		this.#onWarning = options?.onWarning
	}

	/**
	 * Aborted when the registry disposes, before any service disposal runs.
	 */
	public get signal(): AbortSignal {
		return this.#abortController.signal
	}

	/**
	 * Register a resolver under a token. Records the service for disposal immediately —
	 * registration, not first-await, is what enters it into the lifecycle.
	 */
	public register<T extends object>(
		token: ServiceToken<T>,
		resolver: ServiceResolver<T>
	): Service<T> & ServiceProxy<T> {
		this.#assertNotDisposed()

		if (this.#services.has(token)) {
			throw new LifecycleError("E_DUPLICATE_TOKEN", `A service is already registered for token "${token.description}".`)
		}

		const service = new Service<T>(resolver, { signal: this.signal })
		this.#stack.use(service)

		const proxied = proxyService(service)
		this.#services.set(token, proxied as unknown as Service<object> & ServiceProxy<object>)

		return proxied
	}

	/**
	 * Look up a token. Throws {@linkcode LifecycleError} `E_UNRESOLVED_TOKEN` when absent.
	 */
	public get<T extends object>(token: ServiceToken<T>): Service<T> & ServiceProxy<T> {
		const found = this.#lookup(token)

		if (!found) {
			throw new LifecycleError("E_UNRESOLVED_TOKEN", `No service registered for token "${token.description}".`)
		}

		return found as unknown as Service<T> & ServiceProxy<T>
	}

	#lookup(token: ServiceToken<unknown>): (Service<object> & ServiceProxy<object>) | null {
		return this.#services.get(token) ?? null
	}

	#assertNotDisposed(): void {
		if (this.#disposed) {
			throw new LifecycleError("E_DISPOSED", "The service registry has been disposed.")
		}
	}

	public async [Symbol.asyncDispose](): Promise<void> {
		if (this.#disposed) {
			this.#onWarning?.("Service registry already disposed.")

			return
		}

		this.#disposed = true
		this.#abortController.abort(new LifecycleError("E_DISPOSED", "The service registry is disposing."))

		await this.#stack.disposeAsync()
		this.#services.clear()
	}

	/**
	 * Alias for `[Symbol.asyncDispose]()`.
	 */
	public dispose(): Promise<void> {
		return this[Symbol.asyncDispose]()
	}
}

/**
 * The module-level default registry — the convenience path for applications with one scope.
 */
export const defaultRegistry: ServiceRegistry = new ServiceRegistry()
```

- [ ] **Step 5: Run test to verify it passes**

Run: `yarn vitest run test/registry.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 6: Commit**

```bash
git add lib/token.ts lib/registry.ts test/registry.test.ts
git commit -m "feat: ServiceRegistry + tokens — stack-backed LIFO disposal, abort-first, register-time recording"
```

---

### Task 7: Injectable constructors + static cycle detection

**Files:**

- Modify: `lib/registry.ts`
- Test: `test/injectable.test.ts`

**Interfaces:**

- Consumes: everything from Task 6.
- Produces (all exported from `lib/registry.ts`):
  - `type TokenInstances<D extends readonly ServiceToken<unknown>[]>`
  - `interface InjectableConstructor<T extends object, D extends readonly ServiceToken<unknown>[]> { readonly dependencies: D; new (...args: TokenInstances<D>): T }`
  - `isInjectableConstructor(input: unknown): input is InjectableConstructor<object, readonly ServiceToken<unknown>[]>`
  - A new `register` overload accepting `InjectableConstructor`.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import { asyncInit } from "../lib/protocol.ts"
import { ServiceRegistry } from "../lib/registry.ts"
import { createToken } from "../lib/token.ts"

class Logger {
	public readonly lines: string[] = []
	public initialized = false

	public async [asyncInit](): Promise<void> {
		this.initialized = true
	}

	public async [Symbol.asyncDispose](): Promise<void> {}

	public log(line: string): void {
		this.lines.push(line)
	}
}

const ILogger = createToken<Logger>("logger")

describe("injectable constructors", () => {
	it("resolves + initializes declared dependencies BEFORE the constructor body runs", async () => {
		class Indexer {
			public static readonly dependencies = [ILogger] as const

			public readonly sawInitializedLogger: boolean

			constructor(logger: Logger) {
				// The whole point: the dependency is usable inside the constructor.
				logger.log("indexer constructed")
				this.sawInitializedLogger = logger.initialized
			}

			public async [Symbol.asyncDispose](): Promise<void> {}
		}

		const IIndexer = createToken<Indexer>("indexer")

		await using registry = new ServiceRegistry()
		registry.register(ILogger, Logger)
		registry.register(IIndexer, Indexer)

		const indexer = await registry.get(IIndexer)
		expect(indexer.sawInitializedLogger).toBe(true)

		const logger = await registry.get(ILogger)
		expect(logger.lines).toEqual(["indexer constructed"])
	})

	it("shares dependency instances (memoized through the same handles)", async () => {
		class ConsumerA {
			public static readonly dependencies = [ILogger] as const
			public readonly logger: Logger

			constructor(logger: Logger) {
				this.logger = logger
			}

			public async [Symbol.asyncDispose](): Promise<void> {}
		}

		class ConsumerB {
			public static readonly dependencies = [ILogger] as const
			public readonly logger: Logger

			constructor(logger: Logger) {
				this.logger = logger
			}

			public async [Symbol.asyncDispose](): Promise<void> {}
		}

		const IA = createToken<ConsumerA>("consumer-a")
		const IB = createToken<ConsumerB>("consumer-b")

		await using registry = new ServiceRegistry()
		registry.register(ILogger, Logger)
		registry.register(IA, ConsumerA)
		registry.register(IB, ConsumerB)

		const [a, b] = await Promise.all([registry.get(IA).resolve(), registry.get(IB).resolve()])
		expect(a.logger).toBe(b.logger)
	})

	it("throws E_MISSING_DEPENDENCY naming both the requester and the missing token", async () => {
		class Needy {
			public static readonly dependencies = [ILogger] as const

			constructor(_logger: Logger) {}

			public async [Symbol.asyncDispose](): Promise<void> {}
		}

		const INeedy = createToken<Needy>("needy")

		await using registry = new ServiceRegistry()
		registry.register(INeedy, Needy)

		const error: unknown = await registry
			.get(INeedy)
			.resolve()
			.then(
				() => null,
				(caught: unknown) => caught
			)

		expect(error).toMatchObject({ code: "E_MISSING_DEPENDENCY" })
		expect((error as Error).message).toContain("needy")
		expect((error as Error).message).toContain("logger")
	})

	it("throws E_DEPENDENCY_CYCLE with the full path", async () => {
		const IA = createToken<object>("a")
		const IB = createToken<object>("b")

		class A {
			public static readonly dependencies = [IB] as const
			constructor(_b: object) {}
			public async [Symbol.asyncDispose](): Promise<void> {}
		}

		class B {
			public static readonly dependencies = [IA] as const
			constructor(_a: object) {}
			public async [Symbol.asyncDispose](): Promise<void> {}
		}

		await using registry = new ServiceRegistry()
		registry.register(IA, A)
		registry.register(IB, B)

		await expect(registry.get(IA).resolve()).rejects.toThrowError(
			expect.objectContaining({
				code: "E_DEPENDENCY_CYCLE",
				message: expect.stringContaining("a → b → a"),
			})
		)
	})

	it("detects indirect cycles (a → b → c → a)", async () => {
		const IA = createToken<object>("a")
		const IB = createToken<object>("b")
		const IC = createToken<object>("c")

		class A {
			public static readonly dependencies = [IB] as const
			constructor(_b: object) {}
			public async [Symbol.asyncDispose](): Promise<void> {}
		}
		class B {
			public static readonly dependencies = [IC] as const
			constructor(_c: object) {}
			public async [Symbol.asyncDispose](): Promise<void> {}
		}
		class C {
			public static readonly dependencies = [IA] as const
			constructor(_a: object) {}
			public async [Symbol.asyncDispose](): Promise<void> {}
		}

		await using registry = new ServiceRegistry()
		registry.register(IA, A)
		registry.register(IB, B)
		registry.register(IC, C)

		await expect(registry.get(IA).resolve()).rejects.toThrowError(
			expect.objectContaining({ code: "E_DEPENDENCY_CYCLE" })
		)
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run test/injectable.test.ts`
Expected: FAIL — injectable constructors resolve as plain zero-arg constructors (dependency array ignored), so constructor bodies receive `undefined`.

- [ ] **Step 3: Extend `lib/registry.ts`**

Add these exports ABOVE the `ServiceRegistry` class:

```ts
/**
 * Maps a tuple of tokens to the tuple of instance types they carry.
 */
export type TokenInstances<D extends readonly ServiceToken<unknown>[]> = {
	[K in keyof D]: D[K] extends ServiceToken<infer T> ? T : never
}

/**
 * A class declaring its dependencies as a static token tuple. The constructor signature must
 * match the token tuple — a mismatch is a compile error. Dependencies are resolved AND
 * initialized before construction, so the constructor body may use them freely.
 */
export interface InjectableConstructor<T extends object, D extends readonly ServiceToken<unknown>[]> {
	readonly dependencies: D
	new (...args: TokenInstances<D>): T
}

/**
 * Type-predicate: a constructor carrying a static `dependencies` token array.
 */
export function isInjectableConstructor(
	input: unknown
): input is InjectableConstructor<object, readonly ServiceToken<unknown>[]> {
	return typeof input === "function" && Array.isArray((input as { dependencies?: unknown }).dependencies)
}
```

Inside `ServiceRegistry`, add a dependency-graph field next to `#services`:

```ts
	#dependencies = new Map<ServiceToken<unknown>, readonly ServiceToken<unknown>[]>()
```

Replace the single `register` signature with overloads (injectable overload FIRST — it is the more specific match) and route injectables through a wrapping factory:

```ts
	public register<T extends object, const D extends readonly ServiceToken<unknown>[]>(
		token: ServiceToken<T>,
		resolver: InjectableConstructor<T, D>,
	): Service<T> & ServiceProxy<T>
	public register<T extends object>(token: ServiceToken<T>, resolver: ServiceResolver<T>): Service<T> & ServiceProxy<T>
	public register<T extends object>(
		token: ServiceToken<T>,
		resolver: ServiceResolver<T> | InjectableConstructor<T, readonly ServiceToken<unknown>[]>,
	): Service<T> & ServiceProxy<T> {
		this.#assertNotDisposed()

		if (this.#services.has(token)) {
			throw new LifecycleError("E_DUPLICATE_TOKEN", `A service is already registered for token "${token.description}".`)
		}

		let effectiveResolver: ServiceResolver<T>

		if (isInjectableConstructor(resolver)) {
			this.#dependencies.set(token, resolver.dependencies)
			effectiveResolver = this.#createInjectableFactory(token, resolver as InjectableConstructor<T, readonly ServiceToken<unknown>[]>)
		} else {
			effectiveResolver = resolver
		}

		const service = new Service<T>(effectiveResolver, { signal: this.signal })
		this.#stack.use(service)

		const proxied = proxyService(service)
		this.#services.set(token, proxied as unknown as Service<object> & ServiceProxy<object>)

		return proxied
	}

	#createInjectableFactory<T extends object>(
		token: ServiceToken<T>,
		Injectable: InjectableConstructor<T, readonly ServiceToken<unknown>[]>,
	): ServiceResolver<T> {
		return async (): Promise<T> => {
			this.#assertAcyclic(token)

			const instances = await Promise.all(
				Injectable.dependencies.map((dependency) => {
					const dependencyService = this.#lookup(dependency)

					if (!dependencyService) {
						throw new LifecycleError(
							"E_MISSING_DEPENDENCY",
							`"${token.description}" requires "${dependency.description}", which is not registered.`,
						)
					}

					return dependencyService.resolve()
				}),
			)

			return new Injectable(...(instances as TokenInstances<readonly ServiceToken<unknown>[]>))
		}
	}

	#dependenciesOf(token: ServiceToken<unknown>): readonly ServiceToken<unknown>[] {
		return this.#dependencies.get(token) ?? []
	}

	/**
	 * Walk the statically declared dependency graph looking for a path back to `root`.
	 *
	 * Static analysis on declared token tuples — deterministic, immune to async interleaving.
	 * Cycles hidden inside opaque factory resolvers cannot be detected (they hang instead);
	 * that limitation is documented in the README.
	 */
	#assertAcyclic(root: ServiceToken<unknown>): void {
		const visited = new Set<ServiceToken<unknown>>()

		const visit = (token: ServiceToken<unknown>, path: readonly ServiceToken<unknown>[]): void => {
			for (const dependency of this.#dependenciesOf(token)) {
				if (dependency === root) {
					const cycle = [...path, dependency].map((entry) => entry.description).join(" → ")

					throw new LifecycleError("E_DEPENDENCY_CYCLE", `Dependency cycle detected: ${cycle}`)
				}

				if (visited.has(dependency)) continue

				visited.add(dependency)
				visit(dependency, [...path, dependency])
			}
		}

		visit(root, [root])
	}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn vitest run test/injectable.test.ts test/registry.test.ts`
Expected: PASS (5 + 9 tests — Task 6's suite must not regress)

- [ ] **Step 5: Commit**

```bash
git add lib/registry.ts test/injectable.test.ts
git commit -m "feat: injectable constructors — static dependency tuples, init-before-construct, cycle detection"
```

---

### Task 8: Child scopes + barrel

**Files:**

- Modify: `lib/registry.ts`, `index.ts`
- Test: `test/children.test.ts`

**Interfaces:**

- Consumes: everything from Tasks 6–7.
- Produces: `createChild(options?: ServiceRegistryOptions): ServiceRegistry` on `ServiceRegistry`; parent-chain lookup in `get`/dependency resolution; the finished `index.ts` barrel.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import { ServiceRegistry } from "../lib/registry.ts"
import { createToken } from "../lib/token.ts"

const IValue = createToken<{ readonly value: string } & AsyncDisposable>("value")

function createValue(value: string, onDispose?: () => void): { readonly value: string } & AsyncDisposable {
	return {
		value,
		async [Symbol.asyncDispose](): Promise<void> {
			onDispose?.()
		},
	}
}

describe("createChild", () => {
	it("falls back to the parent chain on lookup", async () => {
		await using parent = new ServiceRegistry()
		parent.register(IValue, createValue("from-parent"))

		const child = parent.createChild()
		expect((await child.get(IValue)).value).toBe("from-parent")
	})

	it("lets a child shadow a parent registration", async () => {
		await using parent = new ServiceRegistry()
		parent.register(IValue, createValue("from-parent"))

		const child = parent.createChild()
		child.register(IValue, createValue("from-child"))

		expect((await child.get(IValue)).value).toBe("from-child")
		expect((await parent.get(IValue)).value).toBe("from-parent")
	})

	it("parent disposal reaches children first (LIFO)", async () => {
		const order: string[] = []

		const parent = new ServiceRegistry()
		parent.register(
			IValue,
			createValue("p", () => order.push("parent-service"))
		)
		await parent.get(IValue).resolve()

		const child = parent.createChild()
		const IChildValue = createToken<AsyncDisposable>("child-value")
		child.register(
			IChildValue,
			createValue("c", () => order.push("child-service"))
		)
		await child.get(IChildValue).resolve()

		await parent.dispose()
		expect(order).toEqual(["child-service", "parent-service"])
	})

	it("chains aborts down to descendants", async () => {
		const parent = new ServiceRegistry()
		const child = parent.createChild()
		const grandchild = child.createChild()

		expect(grandchild.signal.aborted).toBe(false)
		await parent.dispose()
		expect(child.signal.aborted).toBe(true)
		expect(grandchild.signal.aborted).toBe(true)
	})

	it("a disposed child unlinks — parent disposal does not double-dispose it", async () => {
		let disposeCount = 0

		const parent = new ServiceRegistry()
		const child = parent.createChild()
		child.register(
			IValue,
			createValue("c", () => (disposeCount += 1))
		)
		await child.get(IValue).resolve()

		await child.dispose()
		expect(disposeCount).toBe(1)

		await parent.dispose()
		expect(disposeCount).toBe(1)
	})

	it("child inherits parent onWarning unless overridden", async () => {
		const parentWarnings: string[] = []
		const childWarnings: string[] = []

		const parent = new ServiceRegistry({ onWarning: (message) => parentWarnings.push(message) })

		const inheriting = parent.createChild()
		await inheriting.dispose()
		await inheriting.dispose()
		expect(parentWarnings).toHaveLength(1)

		const overriding = parent.createChild({ onWarning: (message) => childWarnings.push(message) })
		await overriding.dispose()
		await overriding.dispose()
		expect(childWarnings).toHaveLength(1)
		expect(parentWarnings).toHaveLength(1)

		await parent.dispose()
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run test/children.test.ts`
Expected: FAIL — `createChild` is not a function

- [ ] **Step 3: Extend `lib/registry.ts`**

Add two fields next to `#disposed`:

```ts
	#parent: ServiceRegistry | null = null
	#detachFromParent: (() => void) | null = null
```

Update `#lookup` and `#dependenciesOf` to walk the parent chain (private access across instances of the same class is legal):

```ts
	#lookup(token: ServiceToken<unknown>): (Service<object> & ServiceProxy<object>) | null {
		return this.#services.get(token) ?? this.#parent?.#lookup(token) ?? null
	}

	#dependenciesOf(token: ServiceToken<unknown>): readonly ServiceToken<unknown>[] {
		return this.#dependencies.get(token) ?? this.#parent?.#dependenciesOf(token) ?? []
	}
```

Add `createChild` after `get`:

```ts
	/**
	 * Create a child scope. Lookups fall back to this registry; disposal of this registry
	 * disposes children first (LIFO); aborts chain down. A child disposed on its own unlinks
	 * and is skipped during parent teardown.
	 */
	public createChild(options?: ServiceRegistryOptions): ServiceRegistry {
		this.#assertNotDisposed()

		const child = new ServiceRegistry({ onWarning: options?.onWarning ?? this.#onWarning })
		child.#parent = this
		this.#stack.use(child)

		const propagateAbort = (): void => {
			child.#abortController.abort(this.signal.reason)
		}

		this.signal.addEventListener("abort", propagateAbort, { once: true })
		child.#detachFromParent = (): void => {
			this.signal.removeEventListener("abort", propagateAbort)
		}

		return child
	}
```

In `[Symbol.asyncDispose]`, detach from the parent right after the `#disposed = true` line (a self-disposed child must not fire the parent's abort listener later; the parent's stack entry then hits the idempotent-early-return, which is the "unlink"):

```ts
this.#disposed = true
this.#detachFromParent?.()
```

Note the child-dispose warning nuance: the early-return branch warns "Service registry already disposed." — a child disposed directly and then reached again via parent teardown would emit that warning spuriously. Suppress it for stack-initiated re-entry by removing the warning from `[Symbol.asyncDispose]` and moving it to the `dispose()` alias:

```ts
	public async [Symbol.asyncDispose](): Promise<void> {
		if (this.#disposed) return

		this.#disposed = true
		this.#detachFromParent?.()
		this.#abortController.abort(new LifecycleError("E_DISPOSED", "The service registry is disposing."))

		await this.#stack.disposeAsync()
		this.#services.clear()
		this.#dependencies.clear()
	}

	/**
	 * Alias for `[Symbol.asyncDispose]()`. Warns (via `onWarning`) on repeat calls.
	 */
	public dispose(): Promise<void> {
		if (this.#disposed) {
			this.#onWarning?.("Service registry already disposed.")
		}

		return this[Symbol.asyncDispose]()
	}
```

- [ ] **Step 4: Write the real `index.ts` barrel**

```ts
/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 *   Async construction and disposal lifecycle primitives — protocol symbols, lazy Service
 *   handles, and an optional token-based service registry.
 */

export * from "./lib/errors.ts"
export * from "./lib/protocol.ts"
export * from "./lib/proxy.ts"
export * from "./lib/registry.ts"
export * from "./lib/service.ts"
export * from "./lib/token.ts"
```

- [ ] **Step 5: Run the full suite**

Run: `yarn vitest run`
Expected: PASS — all suites (errors, protocol, service, proxy, registry, injectable, children); registry suite still green with the dispose-warning move.

- [ ] **Step 6: Commit**

```bash
git add lib/registry.ts index.ts test/children.test.ts
git commit -m "feat: child scopes — parent-chain lookup, LIFO teardown, abort chaining, self-dispose unlink"
```

---

### Task 9: Type-level tests

**Files:**

- Test: `test/types.test-d.ts`

**Interfaces:**

- Consumes: the full public surface via `../index.ts`.

- [ ] **Step 1: Write the type-assertion file**

```ts
/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 *   Type-level assertions — run via `yarn test:types` (vitest --typecheck).
 */

import { describe, expectTypeOf, it } from "vitest"
import { createToken, ServiceRegistry } from "../index.ts"
import type { ServiceProxy, ServiceToken, TokenInstances } from "../index.ts"

interface Logger {
	readonly level: number
	log(line: string): Promise<boolean>
}

const ILogger = createToken<Logger>("logger")

describe("ServiceProxy", () => {
	it("methods become promise-returning, properties become thunks", () => {
		expectTypeOf<ServiceProxy<Logger>["log"]>().toEqualTypeOf<(line: string) => Promise<boolean>>()
		expectTypeOf<ServiceProxy<Logger>["level"]>().toEqualTypeOf<() => Promise<number>>()
	})
})

describe("TokenInstances", () => {
	it("maps token tuples to instance tuples", () => {
		expectTypeOf<TokenInstances<readonly [ServiceToken<Logger>, ServiceToken<number>]>>().toEqualTypeOf<
			readonly [Logger, number]
		>()
	})
})

describe("registry inference", () => {
	it("get() infers the token's phantom type", () => {
		const registry = new ServiceRegistry()

		expectTypeOf(registry.get(ILogger).then).parameter(0).parameter(0).toEqualTypeOf<Logger>()
	})

	it("register() rejects a constructor whose signature contradicts its dependencies", () => {
		class Mismatched {
			public static readonly dependencies = [ILogger] as const

			// Declares [ILogger] (a Logger) but demands a string — must NOT be registrable.
			constructor(_wrong: string) {}

			public async [Symbol.asyncDispose](): Promise<void> {}
		}

		const IMismatched = createToken<Mismatched>("mismatched")
		const registry = new ServiceRegistry()

		// @ts-expect-error — constructor parameter types contradict the declared dependency tokens
		registry.register(IMismatched, Mismatched)
	})
})
```

Note for the implementer: `ICount` intentionally exercises a non-object token type inside `TokenInstances` only. If `expectTypeOf(...).parameter(0).parameter(0)` proves awkward against the `then` overloads, an equivalent assertion is:

```ts
const service = registry.get(ILogger)
expectTypeOf(service.resolve()).resolves.toEqualTypeOf<Logger>()
```

- [ ] **Step 2: Run the typecheck suite**

Run: `yarn test:types`
Expected: PASS. Also confirm the `@ts-expect-error` is load-bearing: temporarily fix `Mismatched`'s constructor to `constructor(_logger: Logger)`, re-run, and the suite must FAIL with "unused @ts-expect-error"; revert.

- [ ] **Step 3: Commit**

```bash
git add test/types.test-d.ts
git commit -m "test: type-level assertions — proxy thunks, token tuples, injectable signature enforcement"
```

---

### Task 10: README + final verification sweep

**Files:**

- Create: `README.md`
- Modify: none (verification only)

- [ ] **Step 1: Write `README.md`**

Structure (follow the sister.software house voice — second person, problem → empathy → solution, name the cost; consult `path-ts/README.md` for register):

1. **Title + one-liner**: lifecycle-ts — async construction and disposal lifecycle primitives; the missing symbol for constructing asynchronous things.
2. **The problem**: classes that need async setup after `new` and orderly async teardown; ad-hoc `ready()` conventions don't compose with `await using`/`AsyncDisposableStack`.
3. **The protocol** — `asyncInit` symbol, `init()`, `construct()`, guards. Code example from the Task 3 test.
4. **Lazy handles** — `Service<T>`, awaitability, proxy view with thunk semantics. Example from Task 5 test.
5. **The registry** — tokens, `register`/`get`, injectable constructors with static `dependencies` (the erasable-TS answer to parameter-decorator DI), child scopes, `await using registry`. Example from Task 7 test.
6. **Limitations** (verbatim commitments from the spec):
   - Cycles between injectable constructors throw `E_DEPENDENCY_CYCLE`; cycles through opaque factory resolvers cannot be statically detected and will deadlock — break them by depending on the handle and awaiting after construction.
   - Async-only: no sync `Disposable` variants in v1.
7. **Type discipline**: note that the package compiles under `isolatedDeclarations` — every export is explicitly annotated so declaration emit never relies on inference — plus `erasableSyntaxOnly` (runs under bare node type-stripping, no build step needed to consume the source).
8. **License**: MIT.

- [ ] **Step 2: Full verification sweep**

```bash
cd /home/lab/Projects/lifecycle-ts
yarn check-types
yarn compile
yarn test
yarn test:types
yarn lint
```

Expected: all exit 0. If `yarn lint` flags formatting, run `yarn format` and re-check.

- [ ] **Step 3: Confirm zero runtime dependencies and clean packlist**

```bash
node -e "const p=require('./package.json'); if (p.dependencies) throw new Error('runtime deps found'); console.log('zero deps ✓')"
yarn pack -o /tmp/lifecycle-ts-check.tgz && tar -tzf /tmp/lifecycle-ts-check.tgz
```

Expected: `zero deps ✓`; tarball contains `out/**`, `README.md`, `LICENSE.md`, `package.json` only.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: README — protocol, handles, registry, limitations, isolatedDeclarations note"
```

---

## Out of scope for this plan

- **npm publish / GitHub repo creation** — operator-gated (release flow, npm auth). The package stays local until the operator cuts the release.
- **mailwoman migration** — a separate plan per the spec (`core/scripting/utils`, `APIClient`, delete `core/lifecycle`, both exports maps): written after `lifecycle-ts` is reviewed.
- The `AsyncDisposableLRUCache` decision (spec: default delete; decided in the migration PR).
