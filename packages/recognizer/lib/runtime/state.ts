// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Explicit WebAssembly initialization and ownership.
 *
 *   The design follows `lib/runtime/state.ts` of `@sister.software/h3`.
 *
 *   This module does no WebAssembly work on import.
 *   Compilation, instantiation and memory allocation happen only in `init` and in the first recognition.
 *
 *   The first recognition instantiates the engine synchronously from the binary the entry registered,
 *   and `init` preloads it or supplies the binary where synchronous compilation is refused.
 */

import { ABI_VERSION, type Exports } from "#runtime/abi"
import { RecognizerInitializationError, RecognizerRuntimeError } from "#runtime/errors"
import { type CompiledModule, type ModuleBytes, wasm } from "#runtime/webassembly"

/**
 * A family loaded into the instance: its handle and the declarations hash it was loaded with.
 */
export interface LoadedFamily {
	readonly handle: number
	readonly declarationsHash: string
}

/**
 * What a result record's family handle and shape position stand for, read once when the family loads.
 */
export interface FamilyTable {
	readonly id: string
	/**
	 * The shape IDs in the engine's table order.
	 */
	readonly shapes: readonly string[]
}

/**
 * One live engine instance and the families loaded into it.
 */
export interface Instance {
	readonly exports: Exports
	readonly families: Map<string, LoadedFamily>
	/**
	 * Each loaded family's table, indexed by its handle.
	 */
	readonly tables: FamilyTable[]
	/**
	 * The staging buffer the text is encoded into, reused while it is large enough.
	 *
	 * It remembers the text it holds and the bytes written, so a second call over
	 * the same text reuses the encoded bytes.
	 */
	staging: { pointer: number; length: number; text: string | null; written: number }
}

/**
 * The options of {@link init}: at most one of `module` or `bytes`.
 */
export type InitOptions =
	| { module?: never; bytes?: never }
	| { module: CompiledModule; bytes?: never }
	| { bytes: ArrayBuffer | ArrayBufferView; module?: never }

type State =
	| { kind: "uninitialized" }
	| { kind: "initializing"; source: object; promise: Promise<void> }
	| { kind: "ready"; source: object }
	| { kind: "poisoned"; cause: unknown }

let state: State = { kind: "uninitialized" }

/**
 * The live instance, or `null` before readiness.
 * Read on every call.
 */
let live: Instance | null = null

/**
 * The binary the entry module registered for first-call initialization: embedded bytes
 * (default entry) or a bundler-compiled module (workerd entry).
 */
let defaultSource: (() => CompiledModule | ModuleBytes) | null = null

/**
 * The identity of the registered default source, for comparisons in {@link init}.
 */
const DEFAULT_SOURCE = Object.freeze({ defaultSource: true })

/**
 * Registers the binary used when no source is passed to {@link init} and on the first call.
 * Each entry module calls it once.
 *
 * @internal
 */
export function setDefaultSource(source: () => CompiledModule | ModuleBytes): void {
	defaultSource = source
}

function isBytes(value: unknown): value is ArrayBuffer | ArrayBufferView {
	return value instanceof ArrayBuffer || ArrayBuffer.isView(value)
}

/**
 * Copies the bytes, including from a shared buffer, into a fresh unshared array.
 */
function copyBytes(bytes: ArrayBuffer | ArrayBufferView): Uint8Array<ArrayBuffer> {
	const view =
		bytes instanceof ArrayBuffer
			? new Uint8Array(bytes)
			: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)

	return view.slice()
}

/**
 * Instantiates synchronously and makes the instance live.
 * Throws on failure and leaves the state unchanged.
 */
function activate(module: CompiledModule, source: object): Instance {
	const { exports } = new wasm.Instance(module, {})
	const version = exports.rcg_abi_version()

	if (version !== ABI_VERSION) {
		throw new Error(`WebAssembly ABI version ${version} does not match the loader's ABI version ${ABI_VERSION}`)
	}

	live = { exports, families: new Map(), tables: [], staging: { pointer: 0, length: 0, text: null, written: 0 } }
	state = { kind: "ready", source }

	return live
}

function activateDefault(): Instance {
	if (!defaultSource) throw new Error("no default WebAssembly binary is registered; pass `module` or `bytes`")

	const source = defaultSource()
	const module = source instanceof wasm.Module ? source : new wasm.Module(source)

	return activate(module, DEFAULT_SOURCE)
}

/**
 * Optionally initializes the engine ahead of the first call.
 *
 * The call is never required: the first recognition instantiates the package's binary synchronously.
 *
 * Use it to preload during startup or to supply the binary where synchronous compilation is refused:
 * pass a compiled `module`, or `bytes`, the contents of `@mailwoman/recognizer/wasm/recognizer.wasm`.
 * With no source it initializes from the package's own binary.
 *
 * When the engine is already live, any source resolves immediately.
 */
export function init(options: InitOptions = {}): Promise<void> {
	if (typeof options !== "object" || options === null) {
		return Promise.reject(new TypeError("init: options must be an object"))
	}

	const { module, bytes } = options as { module?: unknown; bytes?: unknown }
	const hasModule = module !== undefined
	const hasBytes = bytes !== undefined

	if (hasModule && hasBytes) return Promise.reject(new TypeError("init: pass at most one of `module` or `bytes`"))

	if (hasModule && !(module instanceof wasm.Module)) {
		return Promise.reject(new TypeError("init: `module` must be a WebAssembly.Module"))
	}

	if (hasBytes && !isBytes(bytes)) {
		return Promise.reject(new TypeError("init: `bytes` must be an ArrayBuffer or ArrayBufferView"))
	}

	const source = hasModule ? (module as object) : hasBytes ? (bytes as object) : DEFAULT_SOURCE

	switch (state.kind) {
		case "poisoned":
			return Promise.reject(
				new RecognizerRuntimeError("the recognizer WebAssembly instance trapped and cannot be reused", {
					cause: state.cause,
				})
			)
		case "ready":
			// The engine is live, possibly from the first call, so any source is equivalent.
			return Promise.resolve()
		case "initializing":
			if (state.source === source) return state.promise

			return Promise.reject(
				new RecognizerInitializationError("init: initialization from a different source is already pending")
			)
		case "uninitialized":
			break
	}

	if (!hasModule && !hasBytes) {
		try {
			activateDefault()

			return Promise.resolve()
		} catch (error) {
			return Promise.reject(
				new RecognizerInitializationError(`init: failed to initialize the engine: ${String(error)}`, { cause: error })
			)
		}
	}

	// A module the caller compiled needs no asynchronous step, so the engine is ready when `init` returns.
	if (hasModule) {
		try {
			activate(module as CompiledModule, source)

			return Promise.resolve()
		} catch (error) {
			return Promise.reject(
				new RecognizerInitializationError(`init: failed to initialize the engine: ${String(error)}`, { cause: error })
			)
		}
	}

	// The bytes are copied before the first asynchronous gap, so a caller may reuse its buffer.
	const copied = copyBytes(bytes as ArrayBuffer | ArrayBufferView)

	const promise = (async () => {
		activate(await wasm.compile(copied), source)
	})().catch((error: unknown) => {
		state = { kind: "uninitialized" }
		live = null

		throw new RecognizerInitializationError(`init: failed to initialize the engine: ${String(error)}`, {
			cause: error,
		})
	})

	state = { kind: "initializing", source, promise }

	return promise
}

/**
 * Returns the live instance, instantiating the default binary synchronously on first use.
 * Every recognition calls it.
 *
 * @internal
 */
export function ready(): Instance {
	if (live !== null) return live

	if (state.kind === "poisoned") {
		throw new RecognizerRuntimeError("the recognizer WebAssembly instance trapped and cannot be reused", {
			cause: state.cause,
		})
	}

	if (state.kind === "initializing") {
		throw new RecognizerInitializationError(
			"the engine is still initializing from the source passed to init(); await it before recognizing"
		)
	}

	try {
		return activateDefault()
	} catch (error) {
		throw new RecognizerInitializationError(
			`the engine could not instantiate its WebAssembly binary synchronously (${String(error)}). ` +
				"Where synchronous compilation is not allowed, call and await init({ module }) or init({ bytes }) first.",
			{ cause: error }
		)
	}
}

/**
 * Converts an exception thrown out of WebAssembly into the public error.
 * A trap poisons the instance.
 *
 * @internal
 */
export function trapped(error: unknown): unknown {
	if (error instanceof wasm.RuntimeError) {
		state = { kind: "poisoned", cause: error }
		live = null

		return new RecognizerRuntimeError("the recognizer WebAssembly instance trapped and cannot be reused", {
			cause: error,
		})
	}

	return error
}

/**
 * The current state's kind, for tests.
 *
 * @internal
 */
export function stateKind(): State["kind"] {
	return state.kind
}

/**
 * Returns the module to its first state, for tests that exercise first-call behavior more than once.
 *
 * @internal
 */
export function resetForTests(): void {
	state = { kind: "uninitialized" }
	live = null
}
