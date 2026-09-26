# lifecycle-ts — design spec

**Date:** 2026-07-18
**Status:** Approved in conversation; pending written-spec review
**Origin:** Extraction + from-scratch redesign of `mailwoman` `core/lifecycle`

## Motivation

`core/lifecycle` gives a common lifecycle to constructable API clients and file
writers. These classes share little except an async construction step (`ready()`
and similar) and orderly async disposal. The design is a lightweight version of VS
Code's internal dependency-injection system, in which interface types are paired
with runtime tokens. It is built on the standard `AsyncDisposable` protocol and
`AsyncDisposableStack`, and it adds the JavaScript symbol that is missing for
_constructing_ asynchronous objects.

The current module has design-level flaws: inert dispose guards, type predicates
that check the wrong object, a resolve race, and proxy types that misdescribe the runtime values
(see the bug ledger below). It also reaches into `@mailwoman/core` internals (`ResourceError`,
`ConsoleLogger`). Instead of patching it in place, we redesign the API from
scratch as a standalone package and migrate mailwoman onto it.

**Type ergonomics are a first-order requirement.** Every call site must get full
inference, the public surface must contain no `any`, and the types must describe all
runtime behavior.

## Package identity

| Field    | Value                                                                                              |
| -------- | -------------------------------------------------------------------------------------------------- |
| Name     | `lifecycle-ts`                                                                                     |
| Repo     | `sister-software/lifecycle-ts` (standalone, like `path-ts`)                                        |
| License  | MIT                                                                                                |
| Deps     | **Zero** runtime dependencies                                                                      |
| Tooling  | Source-first TS (node type-stripping), vitest, oxlint + oxfmt — cloned from the `path-ts` template |
| tsconfig | `erasableSyntaxOnly`, `isolatedModules`, **`isolatedDeclarations: true`**                          |

`isolatedDeclarations` is enabled from the first release. Every export carries explicit
type annotations, so declaration emit needs no inference. The README documents
the option and explains why the package enforces it. If the flag ever conflicts with
the proxy types, drop the flag and keep the README note.

**Excluded from the package:**

- `AsyncDisposableLRUCache`. It has zero consumers and would add `lru-cache` as the only
  dependency. It stays in mailwoman, and the migration PR decides its fate.
- HTTP-flavored errors.
- Any logger dependency.
- Decorators of any kind. Stage-3 decorators have no parameter decorators, and node
  type-stripping cannot execute decorator metadata.

## Architecture — three strictly ordered layers

```
protocol   → symbols + interfaces + type guards   (zero runtime state; no registry needed)
handle     → Service<T> lazy awaitable wrapper    (usable standalone)
registry   → ServiceRegistry scoped container     (fully optional)
```

Each layer works without the layer above it. Direct construction always
remains possible, and the registry is an optional convenience.

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

- **Namespaced `Symbol.for`**: when npm dedup fails and two module copies load, both
  copies still agree on symbol identity. The namespace avoids the collision risk of a bare
  `Symbol.for("asyncInit")`.
- The `ready?()` alias from the old design is **dropped**. The symbol is the only
  protocol. A class that wants a friendly method name can call its own symbol method.
- Guards: each one walks the prototype chain with `in` and narrows as a
  type predicate.
  - `isAsyncInitializable(input): input is AsyncInitializable`
  - `isAsyncDisposable(input): input is AsyncDisposable` fixes the old bug in which
    `Object.hasOwn` on the instance missed prototype methods.
  - `isDisposed(input): boolean`
  - `markDisposed(input): boolean` sets the **actual** `disposed` symbol.
    The old code set a literal string key, so the guard never fired.
- Helpers:
  - `init<T extends AsyncInitializable>(instance: T, context?): Promise<T>`
    awaits `[asyncInit]` and returns the instance.
  - `construct(Ctor, ...args)` runs `new` and `init` in one call. `args` is typed through
    `ConstructorParameters<typeof Ctor>`.

## Layer 2 — handle: `Service<T>`

`Service<T>` is a lazy, awaitable, disposable wrapper. It implements
`PromiseLike<T>` **and** `AsyncDisposable`, so it works directly with
`await using` and `AsyncDisposableStack.use()`.

**Resolver forms** (the `ServiceResolver<T>` union):

1. Pre-built instance
2. Factory: `(context: LifecycleContext) => T | Promise<T>`
3. Constructor: `new () => T`
4. Injectable constructor (registry layer; see below)

**Semantics — each fixes a flaw in the old module:**

- **Promise-memoized resolution.** `resolve()` stores the in-flight promise instead of the instance, so concurrent awaits share one resolution. The old code
  raced and could construct duplicate instances, leaking one of them. A _failed_
  resolution clears the memo so that a later await can retry.
- **Every resolver form runs `[asyncInit]`** and receives the
  `LifecycleContext`. The old constructor branch skipped init and dropped the
  context.
- **Reliable class-vs-factory detection.** Prototype-chain `in` checks decide most cases, and a
  `Function.prototype.toString().startsWith("class")` check breaks ties. An
  inherited-disposable subclass is never called without `new`. The old
  `Object.hasOwn(prototype, …)` check crashed on exactly that case.
- **Accurate proxy types.** The method-resolver proxy stays, but non-function
  properties are typed as the thunks the runtime returns:

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

The token pairs an interface type with a runtime key, so a service typed by an
interface needs no class. Tokens replace the old `attach()` workaround.

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

- **Instantiable.** Registries are scoped: `await using registry = new
ServiceRegistry()`. The old static singleton that `extends Service` with
  `super(null as never)` is removed. `defaultRegistry` keeps the singleton
  convenience.
- **Backed by `AsyncDisposableStack`.** Native LIFO ordering and
  `SuppressedError` aggregation replace the hand-rolled reverse loop.
- **Registration is recorded at `register` time** instead of on the first await, so a
  resolved service that is never awaited is still disposed. The old code
  populated its map inside `then()`.
- **Registering one token twice throws** `E_DUPLICATE_TOKEN`. The old map
  silently overwrote the entry and leaked the first instance.
- **Dispose aborts `signal` before disposing** so that in-flight resolvers can
  stop early.
- **The registry logs no messages by default.** `onWarning` is the only logging hook, and mailwoman passes
  `ConsoleLogger` at the call site.

### Injectable constructors — declared dependencies

Injectable constructors replace VS Code's parameter-decorator injection with erasable TypeScript,
because decorators are unavailable (see the exclusions above):

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

- The constructor signature must match the token tuple. A mismatch is a compile
  error.
- The registry awaits all declared dependencies, resolved **and**
  `[asyncInit]`-initialized, before it constructs. **Constructors can now use their
  dependencies**, which the old design did not allow. The registry controls construction,
  so dependencies are real instances by the time the constructor body runs.
- A dependency token missing from the registry and its ancestors throws
  `E_MISSING_DEPENDENCY`, and the message includes the token and the requesting class.
- **Cycles are the one remaining case of the old limitation.** In A→B→A, the two services cannot both be
  resolved through their constructors. Resolution detects the cycle and throws
  `E_DEPENDENCY_CYCLE` with the full path. To work around it, declare the dependency
  lazily with a token for the _handle_ (`ServiceToken<Service<T>>`-style) and await
  it after construction. The class then accepts the constraint explicitly.

### Child scopes (nested stacks)

- `createChild()` returns a registry that **registers itself into the
  parent's stack**. Disposing the parent therefore disposes children first, and with native LIFO the
  most recently created child is disposed earliest.
- **Token resolution walks up the chain.** `child.get(token)` falls back to the parent
  chain, so a child can override a token for its own scope.
- **Abort propagates down.** Aborting the parent `signal` aborts every descendant.
  The listener is attached at creation and removed when the child is disposed.
- **A disposed child unlinks itself from the parent stack**, so the parent does not dispose it again
  later.
- Registries also compose with hand-rolled `AsyncDisposableStack`s, so nesting
  does not require a registry at every level.

## Errors

`LifecycleError extends Error` carries a `code` union and has no HTTP semantics:

| Code                   | Raised when                                             |
| ---------------------- | ------------------------------------------------------- |
| `E_NO_RESOLVER`        | `Service` resolved with neither resolver nor instance   |
| `E_INVALID_RESOLVER`   | Resolver is not an instance, factory, or constructor    |
| `E_DUPLICATE_TOKEN`    | Second `register` on the same token in one registry     |
| `E_UNRESOLVED_TOKEN`   | `get` on a token absent from the registry chain         |
| `E_MISSING_DEPENDENCY` | Injectable dependency token absent at resolve time      |
| `E_DEPENDENCY_CYCLE`   | Constructor-resolved dependency cycle (path in message) |
| `E_DISPOSED`           | Operation on a disposed registry or service             |

## Bug ledger — review findings → design action

Traceability from the 2026-07-18 `core/lifecycle` review:

| #   | Finding (old module)                                                                                          | Action in this design                            |
| --- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | `markAsDisposed` set string key `"AsyncDisposedSymbol"`, guards inert                                         | `markDisposed` sets the real `disposed` symbol   |
| 2   | `Object.hasOwn` predicates missed prototype chain (crash on inherited ctor; `APIClient` cache never disposed) | All guards use `in` + class sniff                |
| 3   | `resolve()` memoized instance, raced under concurrent await                                                   | Promise memoization, failure clears memo         |
| 4   | Constructor branch skipped `[asyncInit]` and context                                                          | All resolver forms init with context             |
| 5   | LRU cache double-disposed values; eviction dispose fire-and-forget                                            | Cache excluded from package (fate: migration PR) |
| 6   | Registry learned of services on first await; same-resolver re-register leaked                                 | Recorded at `register`; duplicate token throws   |
| 7   | Proxy types lied for non-function properties                                                                  | `ServiceProxy<T>` types props as thunks          |

## Testing

Tests use Vitest. Every ledger row and every error code gets a test. The targets are:

- Double-dispose guard blocks (mark + isDisposed round-trip)
- Inherited-disposable class resolves via `new` (no bare-call crash)
- Concurrent `await service` constructs exactly one instance; failed resolve retries
- All resolver forms run `[asyncInit]` with context
- Proxy: method call forwards; property access returns typed thunk
- Registry: LIFO dispose order; abort fires before dispose; duplicate token throws; never-awaited resolved service still disposed
- Injectable: deps resolved+initialized before constructor body; missing dep names token+class; cycle throws with path
- Child scopes: parent-chain lookup; child disposes before parent's earlier services; abort chains; disposed child unlinks
- Type-level tests (`expect-type` or `tsd`): `TokenInstances` inference, `ServiceProxy` thunk types, `InjectableConstructor` signature mismatch rejection

## Migration (mailwoman, separate PR after `lifecycle-ts@1.0.0` publishes)

The migration is direct and adds no shims, because the surface is ~6 call sites across 2 files:

- `core/scripting/utils/index.ts` moves to `defaultRegistry`. `abortController.abort(…)` becomes a registry dispose, which aborts first. The `inspect()`-based timeout report is rewritten against the new surface.
- `core/api/APIClient.ts` uses `isAsyncDisposable` from `lifecycle-ts`. Its cache is disposed for the first time, because the old predicate always returned false for prototype methods.
- Delete `core/lifecycle/`, and remove the `./lifecycle` subpath from **both** exports maps in `core/package.json` (dev + `publishConfig`).
- Decide the fate of `AsyncDisposableLRUCache`. It has zero consumers, so the default is to delete it. Keep it only if a consumer appears by then.
- `@mailwoman/core` gains `lifecycle-ts` as a dependency.

## Out of scope

- Decorator-based injection (any flavor)
- Sync `Disposable`/`DisposableStack` variants (async-only for v1)
- Service replacement / hot-swap semantics
- The LRU cache
