/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The WebAssembly batch adapter over `crates/registry-wasm`.
 *
 *   Initialization is explicit: the caller passes the module's bytes or a compiled `WebAssembly.Module`, and this
 *   module compiles the module inside `createRegistry` and at no other time. `registryWasmURL` locates the committed
 *   binaries for a caller that loads them itself, and `preferredWasmVariant` reports whether the host runs `simd128`.
 *   A batch call stages the packed codes in linear memory, crosses the boundary once, and copies the masks into the
 *   caller's buffer. The staging buffers are kept and reused while they are large enough.
 */

import { countryAirportCollisionArtifact } from "#artifacts/country-airport-collision"
import { iataAirportMembershipArtifact } from "#artifacts/iata-airport-membership"
import { iso31661Alpha3MembershipArtifact } from "#artifacts/iso3166-1-alpha3-membership"
import { CODE_LENGTH_3 } from "#key"

/**
 * The location of a committed `wasm/registry*.wasm`, resolved from this module.
 */
export function registryWasmURL(variant: WasmVariant): URL {
	return new URL(`../wasm/${variant === "simd" ? "registry-simd.wasm" : "registry.wasm"}`, import.meta.url)
}

export type WasmVariant = "simd" | "scalar"

/**
 * A `WebAssembly.validate` probe: a module whose one function uses a `v128` constant.
 *
 * It validates on a host with `simd128` and fails on one without.
 * Validation compiles no code and runs no function.
 */
const SIMD_PROBE = new Uint8Array([
	0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
])

/**
 * The variant this host can run: `simd` when it validates the probe, else `scalar`.
 */
export function preferredWasmVariant(): WasmVariant {
	return WebAssembly.validate(SIMD_PROBE) ? "simd" : "scalar"
}

/**
 * A compiled WebAssembly module, as a Worker runtime supplies it.
 *
 * The type is opaque because the Node type preset omits the DOM library that declares
 * `WebAssembly`, and this package's declarations type-check without it.
 */
export interface RegistryCompiledModule {
	readonly [Symbol.toStringTag]: string
}

/**
 * The bytes or compiled module the runtime instantiates from.
 */
export type RegistryWasmSource = RegistryCompiledModule | ArrayBuffer | Uint8Array<ArrayBuffer>

interface LinearMemory {
	readonly buffer: ArrayBuffer
}

/**
 * The members of the global `WebAssembly` object this loader calls.
 */
interface WebAssemblyAPI {
	validate(bytes: ArrayBuffer | Uint8Array<ArrayBuffer>): boolean
	compile(bytes: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<RegistryCompiledModule>
	instantiate(module: RegistryCompiledModule, imports: object): Promise<{ exports: Exports }>
}

/**
 * The runtime's global, typed to the members above.
 * Every JavaScript runtime this package targets defines it.
 */
declare const WebAssembly: WebAssemblyAPI

function isBytes(source: RegistryWasmSource): source is ArrayBuffer | Uint8Array<ArrayBuffer> {
	return source instanceof ArrayBuffer || ArrayBuffer.isView(source)
}

/**
 * The C ABI `crates/registry-wasm` exports.
 */
interface Exports {
	memory: LinearMemory
	rgy_alloc(len: number): number
	rgy_dealloc(ptr: number, len: number): void
	rgy_error(): number
	rgy_simd(): number
	rgy_load(ptr: number, len: number): number
	rgy_classify_many(
		country: number,
		airport: number,
		collision: number,
		input: number,
		count: number,
		output: number
	): number
	rgy_test_many(handle: number, input: number, count: number, output: number): number
}

/**
 * The mask bits `classifyManyInto` writes, equal to `registry_core::lookup::mask`.
 */
export const ClassifyMask = {
	Country: 1,
	Airport: 2,
	Collision: 4,
	Invalid: 0x80,
} as const

/**
 * The artifacts the batch kernels read.
 * Each defaults to the built profile's module.
 */
export interface RegistryWasmArtifacts {
	alpha3?: Uint8Array
	airport?: Uint8Array
	collision?: Uint8Array
}

/**
 * Options for {@link createRegistry}.
 */
export interface CreateRegistryOptions {
	/**
	 * The module bytes, or a module the host compiled.
	 */
	wasm: RegistryWasmSource
	artifacts?: RegistryWasmArtifacts
}

/**
 * A reusable staging buffer in linear memory.
 */
class Staging {
	ptr = 0
	len = 0
	readonly #exports: Exports

	constructor(exports: Exports) {
		this.#exports = exports
	}

	reserve(len: number): number {
		if (len > this.len) {
			if (this.len) {
				this.#exports.rgy_dealloc(this.ptr, this.len)
			}

			this.ptr = this.#exports.rgy_alloc(len)
			this.len = len
		}

		return this.ptr
	}
}

/**
 * An instantiated registry runtime.
 */
export interface RegistryWasm {
	/**
	 * Whether the instantiated module was built with the `simd128` kernels.
	 */
	readonly simd: boolean

	countryAirport: {
		/**
		 * Classifies `count` packed three-byte codes into `out`, one {@link ClassifyMask} byte each.
		 *
		 * `packed` holds `count * 3` bytes.
		 * Returns the count written.
		 * Throws on an output shorter than `count`.
		 */
		classifyManyInto(packed: Uint8Array, out: Uint8Array, count?: number): number

		/**
		 * Classifies an array of strings, allocating the packed input and the result.
		 * For callers that have no bytes.
		 */
		classify(codes: readonly string[]): Uint8Array
	}

	/**
	 * Frees the staging buffers.
	 *
	 * The loaded artifacts stay in memory for the instance's lifetime.
	 */
	dispose(): void
}

const encoder = new TextEncoder()

/**
 * Instantiates the module and loads the three bitsets of the collision batch.
 */
export async function createRegistry(options: CreateRegistryOptions): Promise<RegistryWasm> {
	const module = isBytes(options.wasm) ? await WebAssembly.compile(options.wasm) : options.wasm
	const instance = await WebAssembly.instantiate(module, {})
	const exports = instance.exports

	const load = (bytes: Uint8Array): number => {
		const ptr = exports.rgy_alloc(bytes.byteLength)

		new Uint8Array(exports.memory.buffer, ptr, bytes.byteLength).set(bytes)

		const handle = exports.rgy_load(ptr, bytes.byteLength)

		if (handle < 0) throw new Error(`registry wasm refused an artifact: error ${exports.rgy_error()}`)

		return handle
	}

	const alpha3 = load(options.artifacts?.alpha3 ?? iso31661Alpha3MembershipArtifact())
	const airport = load(options.artifacts?.airport ?? iataAirportMembershipArtifact())
	const collision = load(options.artifacts?.collision ?? countryAirportCollisionArtifact())
	const input = new Staging(exports)
	const output = new Staging(exports)

	const classifyManyInto = (
		packed: Uint8Array,
		out: Uint8Array,
		count = Math.floor(packed.byteLength / CODE_LENGTH_3)
	): number => {
		const inputBytes = count * CODE_LENGTH_3

		if (out.byteLength < count) throw new RangeError(`output holds ${out.byteLength} bytes for ${count} codes`)

		if (packed.byteLength < inputBytes)
			throw new RangeError(`input holds ${packed.byteLength} bytes for ${count} codes`)

		const inPtr = input.reserve(inputBytes)
		const outPtr = output.reserve(count)

		// `memory.buffer` is re-read after every allocation, because growth detaches the previous buffer.
		new Uint8Array(exports.memory.buffer, inPtr, inputBytes).set(packed.subarray(0, inputBytes))

		const written = exports.rgy_classify_many(alpha3, airport, collision, inPtr, count, outPtr)

		if (written < 0) throw new Error(`registry wasm batch failed: error ${exports.rgy_error()}`)

		out.set(new Uint8Array(exports.memory.buffer, outPtr, written))

		return written
	}

	return {
		simd: exports.rgy_simd() === 1,
		countryAirport: {
			classifyManyInto,
			classify(codes) {
				const packed = new Uint8Array(codes.length * CODE_LENGTH_3)

				codes.forEach((code, index) => {
					// A code of any other byte length packs as zero bytes.
					// The kernel marks zero bytes invalid.
					const bytes = encoder.encode(code)

					packed.set(bytes.byteLength === CODE_LENGTH_3 ? bytes : new Uint8Array(CODE_LENGTH_3), index * CODE_LENGTH_3)
				})

				const out = new Uint8Array(codes.length)

				classifyManyInto(packed, out, codes.length)

				return out
			},
		},
		dispose() {
			if (input.len) {
				exports.rgy_dealloc(input.ptr, input.len)
			}

			if (output.len) {
				exports.rgy_dealloc(output.ptr, output.len)
			}

			input.len = output.len = 0
		},
	}
}
