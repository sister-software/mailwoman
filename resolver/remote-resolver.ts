/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `RemoteResolver` — the `Resolver` interface (`resolveTree`) over HTTP. The adapter the interface
 *   docstring anticipated (Phase 4.4): a client POSTs a parsed `AddressTree` + the serializable
 *   `ResolveOpts` to a resolver service, which owns the gazetteer + situs/interpolation shards,
 *   runs the cascade, and returns the resolved tree. Two payoffs:
 *
 *   1. **Multi-instance** — stateless parser nodes (the ~30 MB ONNX model) talk to ONE resolver service
 *        (the multi-GB gazetteer + shards). `parse` locally, `new RemoteResolver(...).resolveTree`
 *        remotely — same interface the in-process `WofResolver` satisfies, so it's a drop-in.
 *   2. **Canary** — point it at a second resolver build (or an adapter fronting Pelias/Nominatim/BAN)
 *        and diff the resolved trees through the identical contract.
 *
 *   Pure transport: `fetch` only, no node-specific deps (runs in the browser too). The
 *   `addressPoints` / `interpolation` opts are LIVE SQLite handles — not serializable — so they're
 *   stripped before the POST; the resolver service supplies its own from the tree's region (the
 *   data lives server-side, which is the whole point). All other opts (defaultCountry, calibration,
 *   hierarchyCompletion, …) ride along.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import type { ResolveOpts, Resolver } from "@mailwoman/core/resolver"

/** `ResolveOpts` minus the non-serializable live lookup handles. What actually crosses the wire. */
export type SerializableResolveOpts = Omit<ResolveOpts, "addressPoints" | "interpolation">

/** Strip the live lookup handles from `ResolveOpts` so the rest can be JSON-serialized over HTTP. */
export function serializableResolveOpts(opts?: ResolveOpts): SerializableResolveOpts | undefined {
	if (!opts) return undefined
	const { addressPoints: _ap, interpolation: _ip, ...rest } = opts

	return rest
}

export interface RemoteResolverOpts {
	/**
	 * Full URL of the resolver service's resolve-tree endpoint, e.g. `http://resolver:7081/api/resolve-tree`.
	 */
	endpoint: string
	/** Injectable fetch (tests / custom agents). Defaults to the global `fetch`. */
	fetch?: typeof fetch
	/** Per-request timeout in ms. Default 10000. */
	timeoutMs?: number
	/** Extra headers (auth, tracing). `Content-Type: application/json` is always set. */
	headers?: Record<string, string>
}

/** The wire request body `POST <endpoint>` expects (and the matching server handler parses). */
export interface ResolveTreeRequest {
	tree: AddressTree
	opts?: SerializableResolveOpts
}

/** The wire response body the server returns. */
export interface ResolveTreeResponse {
	tree: AddressTree
}

export class RemoteResolver implements Resolver {
	readonly #endpoint: string
	readonly #fetch: typeof fetch
	readonly #timeoutMs: number
	readonly #headers: Record<string, string>

	constructor(opts: RemoteResolverOpts) {
		if (!opts.endpoint) throw new Error("RemoteResolver: `endpoint` is required")
		this.#endpoint = opts.endpoint
		this.#fetch = opts.fetch ?? globalThis.fetch
		this.#timeoutMs = opts.timeoutMs ?? 10_000
		this.#headers = opts.headers ?? {}
	}

	async resolveTree(tree: AddressTree, opts?: ResolveOpts): Promise<AddressTree> {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), this.#timeoutMs)

		try {
			const body: ResolveTreeRequest = { tree, opts: serializableResolveOpts(opts) }
			const res = await this.#fetch(this.#endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...this.#headers },
				body: JSON.stringify(body),
				signal: controller.signal,
			})

			if (!res.ok) {
				throw new Error(`RemoteResolver: ${this.#endpoint} → HTTP ${res.status} ${res.statusText}`)
			}
			const json = (await res.json()) as Partial<ResolveTreeResponse>

			if (!json || !json.tree || !Array.isArray(json.tree.roots)) {
				throw new Error("RemoteResolver: malformed response (missing `tree.roots`)")
			}

			return json.tree
		} finally {
			clearTimeout(timer)
		}
	}
}
