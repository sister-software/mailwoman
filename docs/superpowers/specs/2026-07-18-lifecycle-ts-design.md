# lifecycle-ts — design spec

**Date:** 2026-07-18
**Status:** Approved in conversation; pending written-spec review
**Origin:** Extraction + from-scratch redesign of `mailwoman` `core/lifecycle`

## Motivation

`core/lifecycle` normalizes the lifecycle of constructable API clients and file
writers that share little beyond needing an async construction step (`ready()`
et al.) and orderly async disposal. The design goal is a lightweight take on VS
Code's internal dependency-injection system — aliased interface types married
to runtime tokens — built on the standard `AsyncDisposable` protocol and
`AsyncDisposableStack`, in effect adding the missing JavaScript symbol for
_constructing_ asynchronous things.

The current module has design-level flaws (inert dispose guards, wrong-object
type predicates, a resolve race, lying proxy types — see the bug ledger below)
and reaches into `@mailwoman/core` internals (`ResourceError`,
`ConsoleLogger`). Rather than patch in place, the API is redesigned from
scratch as a standalone package, and mailwoman migrates onto it.

**Type ergonomics are a first-order requirement**, not a nice-to-have: full
inference at every call site, no `any` in the public surface, no runtime
behavior the types fail to describe.

## Package identity

| Field    | Value                                                                                              |
| -------- | -------------------------------------------------------------------------------------------------- |
| Name     | `lifecycle-ts`                                                                                     |
| Repo     | `sister-software/lifecycle-ts` (standalone, like `path-ts`)                                        |
| License  | MIT                                                                                                |
| Deps     | **Zero** runtime dependencies                                                                      |
| Tooling  | Source-first TS (node type-stripping), vitest, oxlint + oxfmt — cloned from the `path-ts` template |
| tsconfig | `erasableSyntaxOnly`, `isolatedModules`, **`isolatedDeclarations: true`**                          |

`isolatedDeclarations` is adopted from day one: every export carries explicit
type annotations so declaration emit needs no inference. The README documents
the option and why the package enforces it. Fallback if it ever conflicts with
the proxy types: drop the flag, keep the README note.

**Excluded from the package:** `AsyncDisposableLRUCache` (zero consumers;
would drag in `lru-cache` as the sole dep — stays behind in mailwoman, fate
decided in the migration PR), HTTP-flavored errors, any logger dependency,
decorators of any kind (no parameter decorators in stage-3, and node
type-stripping cannot execute decorator metadata).

## Architecture — three strictly ordered layers

```
protocol   → symbols + interfaces + type guards   (zero runtime state; no registry needed)
handle     → Service<T> lazy awaitable wrapper    (usable standalone)
registry   → ServiceRegistry scoped container     (fully optional)
```

Each layer is usable without the one above it. Direct construction always
remains possible — the registry is a convenience, never a requirement.

## Layer 1 — protocol

```ts
export const asyncInit: unique symbol = Symbol.for("lifecycle-ts.asyncInit")
export const disposed: unique symbol = Symbol.for("lifecycle-ts.disposed")

export interface LifecycleContext {
	readonly signal: AbortSignal
}

export interface AsyncInitializable {
	[asyncInit](context?: LifecycleContext): Promise<void>
}
```

- **Namespaced `Symbol.for`**: survives npm-dedup failure (two module copies
  agree on symbol identity) without the collision risk of a bare
  `Symbol.for("asyncInit")`.
- The `ready?()` alias from the old design is **dropped**. One protocol: the
  symbol. A class wanting a friendly method name calls its own symbol method.
- Guards — all walk the prototype chain via `in`, all narrow as
  type-predicates:
  - `isAsyncInitializable(input): input is AsyncInitializable`
  - `isAsyncDisposable(input): input is AsyncDisposable` — fixes the old
    `Object.hasOwn`-on-instance bug that missed prototype methods
  - `isDisposed(input): boolean`
  - `markDisposed(input): boolean` — sets the **actual** `disposed` symbol
    (the old code set a literal string key, leaving the guard inert)
- Helpers:
  - `init<T extends AsyncInitializable>(instance: T, context?): Promise<T>` —
    awaits `[asyncInit]`, returns the instance.
  - `construct(Ctor, ...args)` — `new` + `init` in one call; `args` typed via
    `ConstructorParameters<typeof Ctor>`.

## Layer 2 — handle: `Service<T>`

A lazy, awaitable, disposable wrapper. `Service<T>` implements
`PromiseLike<T>` **and** `AsyncDisposable`, so it drops directly into
`await using` and `AsyncDisposableStack.use()`.

**Resolver forms** (the `ServiceResolver<T>` union):

1. Pre-built instance
2. Factory: `(context: LifecycleContext) => T | Promise<T>`
3. Constructor: `new () => T`
4. Injectable constructor (registry layer; see below)

**Semantics — each fixes a flaw in the old module:**

- **Promise-memoized resolution.** `resolve()` stores the in-flight promise,
  not the instance — concurrent awaits share one resolution (the old code
  raced and could construct duplicate instances, leaking one). A _failed_
  resolution clears the memo so a later await may retry.
- **Every resolver form runs `[asyncInit]`** and receives the
  `LifecycleContext` (the old constructor branch skipped init and dropped
  context).
- **Reliable class-vs-factory detection.** Prototype-chain `in` checks plus a
  `Function.prototype.toString().startsWith("class")` tiebreak — an
  inherited-disposable subclass is never invoked without `new` (the old
  `Object.hasOwn(prototype, …)` check crashed on exactly that case).
- **Honest proxy types.** The method-resolver proxy survives, but non-function
  properties are typed as what the runtime returns — thunks:

```ts
export type ServiceProxy<T> = {
	[K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : () => Promise<T[K]>
}
```

## Layer 3 — registry: `ServiceRegistry`

### Tokens

```ts
export interface ServiceToken<T> {
	readonly description: string // branded; phantom T
}
export function createToken<T>(description: string): ServiceToken<T>
```

The token marries an interface type to a runtime key — services typed by
interface need no class (replaces the old `attach()` escape valve).

### The registry

```ts
export class ServiceRegistry implements AsyncDisposable {
	constructor(options?: { onWarning?: (message: string) => void })

	register<T>(token: ServiceToken<T>, resolver: ServiceResolver<T>): Service<T> & ServiceProxy<T>
	get<T>(token: ServiceToken<T>): Service<T> & ServiceProxy<T> // E_UNRESOLVED_TOKEN if absent

	createChild(options?: { onWarning?: (message: string) => void }): ServiceRegistry // inherits parent onWarning unless overridden

	readonly signal: AbortSignal;
	[Symbol.asyncDispose](): Promise<void> // abort() first, then LIFO dispose
}

export const defaultRegistry: ServiceRegistry
```

- **Instantiable** — scoped registries, `await using registry = new
ServiceRegistry()`. The old static-singleton-that-`extends Service` with
  `super(null as never)` is gone; the singleton convenience survives as
  `defaultRegistry`.
- **Backed by `AsyncDisposableStack`** — native LIFO ordering and
  `SuppressedError` aggregation replace the hand-rolled reverse loop.
- **Registration recorded at `register` time**, not first-await — a
  resolved-but-never-awaited service can no longer escape disposal (old code
  populated its map inside `then()`).
- **Double-register on one token throws** `E_DUPLICATE_TOKEN` (the old map
  silently overwrote, leaking the first instance).
- **Dispose aborts `signal` before disposing** so in-flight resolvers can
  bail.
- **Silent by default**; `onWarning` is the only logging hook. mailwoman wires
  `ConsoleLogger` at the call site.

### Injectable constructors — declared dependencies

The erasable-TS answer to VS Code's parameter-decorator injection
(decorators being unavailable, see exclusions):

```ts
type TokenInstances<D extends readonly ServiceToken<unknown>[]> = {
	[K in keyof D]: D[K] extends ServiceToken<infer T> ? T : never
}

export interface InjectableConstructor<T, D extends readonly ServiceToken<unknown>[]> {
	readonly dependencies: D
	new (...args: TokenInstances<D>): T
}
```

```ts
class Indexer {
	static dependencies = [ILogger, IFileService] as const
	constructor(logger: Logger, files: FileService) {
		files.watch(…) // ✅ resolved + initialized before construction
	}
}
registry.register(IIndexer, Indexer)
```

- Constructor signature must match the token tuple — a mismatch is a compile
  error.
- The registry awaits all declared dependencies (resolved **and**
  `[asyncInit]`-initialized), then constructs. **The old "cannot use a
  dependency inside the constructor" limitation is lifted** — construction is
  under registry control, so dependencies are real instances by the time the
  constructor body runs.
- A dependency token missing from the registry (and its ancestors) throws
  `E_MISSING_DEPENDENCY`, naming the token and the requesting class.
- **Cycles are the one survivor of the old limitation.** A→B→A cannot both be
  constructor-resolved; resolution detects the cycle and throws
  `E_DEPENDENCY_CYCLE` naming the full path. Escape: declare the dependency
  lazily (token of the _handle_, `ServiceToken<Service<T>>`-style) and await
  it after construction — opting into the constraint explicitly instead of
  being silently limited.

### Child scopes (nested stacks)

- `createChild()` returns a registry that **registers itself into the
  parent's stack** — parent dispose reaches children first (native LIFO:
  latest-created child dies earliest).
- **Token resolution walks up**: `child.get(token)` falls back to the parent
  chain — scoped overrides for free.
- **Abort chains down**: parent `signal` abort aborts every descendant
  (listener attached at creation, removed on child dispose).
- **A disposed child unlinks from the parent stack** — no double-dispose when
  the parent later goes down.
- Registries also compose with hand-rolled `AsyncDisposableStack`s — nesting
  does not require a registry at every level.

## Errors

`LifecycleError extends Error` with a `code` union — no HTTP semantics:

| Code                   | Raised when                                             |
| ---------------------- | ------------------------------------------------------- |
| `E_NO_RESOLVER`        | `Service` resolved with neither resolver nor instance   |
| `E_INVALID_RESOLVER`   | Resolver is not an instance, factory, or constructor    |
| `E_DUPLICATE_TOKEN`    | Second `register` on the same token in one registry     |
| `E_UNRESOLVED_TOKEN`   | `get` on a token absent from the registry chain         |
| `E_MISSING_DEPENDENCY` | Injectable dependency token absent at resolve time      |
| `E_DEPENDENCY_CYCLE`   | Constructor-resolved dependency cycle (path in message) |
| `E_DISPOSED`           | Operation on a disposed registry or service             |

## Bug ledger — review findings → design remedy

Traceability from the 2026-07-18 `core/lifecycle` review:

| #   | Finding (old module)                                                                                          | Remedy in this design                            |
| --- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | `markAsDisposed` set string key `"AsyncDisposedSymbol"`, guards inert                                         | `markDisposed` sets the real `disposed` symbol   |
| 2   | `Object.hasOwn` predicates missed prototype chain (crash on inherited ctor; `APIClient` cache never disposed) | All guards use `in` + class sniff                |
| 3   | `resolve()` memoized instance, raced under concurrent await                                                   | Promise memoization, failure clears memo         |
| 4   | Constructor branch skipped `[asyncInit]` and context                                                          | All resolver forms init with context             |
| 5   | LRU cache double-disposed values; eviction dispose fire-and-forget                                            | Cache excluded from package (fate: migration PR) |
| 6   | Registry learned of services on first await; same-resolver re-register leaked                                 | Recorded at `register`; duplicate token throws   |
| 7   | Proxy types lied for non-function properties                                                                  | `ServiceProxy<T>` types props as thunks          |

## Testing

Vitest; every ledger row and every error code gets a test. Enumerated targets:

- Double-dispose guard actually blocks (mark + isDisposed round-trip)
- Inherited-disposable class resolves via `new` (no bare-call crash)
- Concurrent `await service` constructs exactly one instance; failed resolve retries
- All resolver forms run `[asyncInit]` with context
- Proxy: method call forwards; property access returns typed thunk
- Registry: LIFO dispose order; abort fires before dispose; duplicate token throws; never-awaited resolved service still disposed
- Injectable: deps resolved+initialized before constructor body; missing dep names token+class; cycle throws with path
- Child scopes: parent-chain lookup; child disposes before parent's earlier services; abort chains; disposed child unlinks
- Type-level tests (`expect-type` or `tsd`): `TokenInstances` inference, `ServiceProxy` thunk types, `InjectableConstructor` signature mismatch rejection

## Migration (mailwoman, separate PR after `lifecycle-ts@1.0.0` publishes)

Direct migration — no shims (surface is ~6 call sites across 2 files):

- `core/scripting/utils/index.ts` → `defaultRegistry`: `abortController.abort(…)` → registry dispose (which aborts first); `inspect()`-based timeout report reworked against the new surface.
- `core/api/APIClient.ts` → `isAsyncDisposable` from `lifecycle-ts` — its cache gets disposed for the first time (old predicate always returned false for prototype methods).
- Delete `core/lifecycle/`; remove the `./lifecycle` subpath from **both** exports maps in `core/package.json` (dev + `publishConfig`).
- Decide `AsyncDisposableLRUCache`: zero consumers → default is delete; keep only if a consumer appears by then.
- `@mailwoman/core` gains `lifecycle-ts` as a dependency.

## Out of scope

- Decorator-based injection (any flavor)
- Sync `Disposable`/`DisposableStack` variants (async-only for v1)
- Service replacement / hot-swap semantics
- The LRU cache
