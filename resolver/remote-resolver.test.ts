/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for `RemoteResolver` + `serializableResolveOpts` — transport behavior with a stubbed
 *   fetch, no network. The live round-trip against a real resolver service is covered in
 *   `mailwoman/test/geocode-router.test.ts`.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import type { AddressPointLookup, InterpolationLookup, ResolveOpts } from "@mailwoman/core/resolver"
import { describe, expect, test, vi } from "vitest"

import { RemoteResolver, serializableResolveOpts } from "./remote-resolver.js"

const tree: AddressTree = {
	raw: "100 Main St, Austin, TX",
	roots: [{ tag: "region", value: "TX", start: 0, end: 2, confidence: 1, children: [] }],
}

function stubFetch(response: unknown, status = 200) {
	return vi.fn(async () => ({
		ok: status >= 200 && status < 300,
		status,
		statusText: "",
		json: async () => response,
	})) as unknown as typeof fetch
}

describe("serializableResolveOpts", () => {
	test("strips the live lookup handles, keeps the rest", () => {
		const opts: ResolveOpts = {
			defaultCountry: "US",
			maxLookups: 3,
			interpolationRadiusCalibration: 1.7,
			addressPoints: {} as AddressPointLookup,
			interpolation: {} as InterpolationLookup,
		}
		const out = serializableResolveOpts(opts)!
		expect(out).toEqual({ defaultCountry: "US", maxLookups: 3, interpolationRadiusCalibration: 1.7 })
		expect("addressPoints" in out).toBe(false)
		expect("interpolation" in out).toBe(false)
	})

	test("undefined passes through", () => {
		expect(serializableResolveOpts(undefined)).toBeUndefined()
	})
})

describe("RemoteResolver", () => {
	test("POSTs { tree, opts(stripped) } and returns the response tree", async () => {
		const resolved: AddressTree = { raw: tree.raw, roots: [{ ...tree.roots[0]!, placeID: "wof:1" } as never] }
		const fetchSpy = stubFetch({ tree: resolved })
		const r = new RemoteResolver({ endpoint: "http://resolver/api/resolve-tree", fetch: fetchSpy })

		const got = await r.resolveTree(tree, { defaultCountry: "US", addressPoints: {} as AddressPointLookup })

		expect(got).toEqual(resolved)
		const [, init] = (fetchSpy as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!
		const body = JSON.parse(init.body as string)
		expect(body.tree.raw).toBe(tree.raw)
		expect(body.opts).toEqual({ defaultCountry: "US" }) // addressPoints stripped
	})

	test("throws on a non-2xx response", async () => {
		const r = new RemoteResolver({ endpoint: "http://resolver/x", fetch: stubFetch({}, 503) })
		await expect(r.resolveTree(tree)).rejects.toThrow(/HTTP 503/)
	})

	test("throws on a malformed response (no tree.roots)", async () => {
		const r = new RemoteResolver({ endpoint: "http://resolver/x", fetch: stubFetch({ nope: true }) })
		await expect(r.resolveTree(tree)).rejects.toThrow(/malformed/)
	})

	test("requires an endpoint", () => {
		expect(() => new RemoteResolver({ endpoint: "" })).toThrow(/endpoint/)
	})
})
