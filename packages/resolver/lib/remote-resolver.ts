/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import { stringifyJSON } from "@mailwoman/core/json"
import type { ResolveOpts, Resolver } from "@mailwoman/core/resolver"

/**
 * Describes the `ResolveOpts` sent over the wire, which omit the live `addressPoints`
 * and `interpolation` lookup handles because they cannot be serialized.
 */
export type SerializableResolveOpts = Omit<ResolveOpts, "addressPoints" | "interpolation">

/**
 * Strip the live lookup handles from `ResolveOpts` so the rest can be JSON-serialized over http.
 */
export function serializableResolveOpts(opts?: ResolveOpts): SerializableResolveOpts | undefined {
	if (!opts) return undefined
	const { addressPoints: _ap, interpolation: _ip, ...rest } = opts

	return rest
}

/**
 * Describes the subset of `fetch` that {@link RemoteResolver} calls,
 * so callers can inject a custom or test implementation.
 */
export type RemoteResolverFetch = (
	url: string,
	init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; statusText: string; json(): Promise<unknown> }>

/**
 * Configures a {@link RemoteResolver}: the endpoint to POST to, an optional `fetch`,
 * a timeout (10 seconds by default), and extra request headers.
 */
export interface RemoteResolverOpts {
	/**
	 * Gives the full URL of the resolver service's resolve-tree endpoint,
	 * such as `http://resolver:7081/v1/resolve`.
	 */
	endpoint: string

	/**
	 * Supplies a fetch implementation for tests or custom agents, defaulting to the global `fetch`.
	 */
	fetch?: RemoteResolverFetch

	/**
	 * Sets the per-request timeout in milliseconds, defaulting to 10,000.
	 */
	timeoutMs?: number

	/**
	 * Adds request headers, such as auth or tracing, which are merged over the
	 * default `Content-Type: application/json`.
	 */
	headers?: Record<string, string>
}

/**
 * The wire request body `post <endpoint>` expects (and the matching server handler parses).
 */
export interface ResolveTreeRequest {
	tree: AddressTree
	opts?: SerializableResolveOpts
}

/**
 * The wire response body the server returns.
 */
export interface ResolveTreeResponse {
	tree: AddressTree
}

/**
 * Resolves address trees by POSTing them to a remote resolver endpoint, so a client
 * can resolve without loading gazetteer databases itself.
 *
 * Live lookup handles in `ResolveOpts` are dropped before sending, so the server resolves with its own.
 */
export class RemoteResolver implements Resolver {
	readonly #endpoint: string
	readonly #fetch: RemoteResolverFetch
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
				body: stringifyJSON(body),
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
