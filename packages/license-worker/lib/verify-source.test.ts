/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { verifySourceURL } from "#verify-source"

function fetchScript(answers: Record<string, { status: number; body: string }>): {
	fetch: typeof fetch
	requested: string[]
} {
	const requested: string[] = []

	const stub = (async (input: RequestInfo | URL) => {
		const url = String(input)

		requested.push(url)

		const answer = answers[url] ?? { status: 404, body: "" }

		return new Response(answer.body, { status: answer.status })
	}) as typeof fetch

	return { fetch: stub, requested }
}

describe("verifySourceURL", () => {
	it("reads LICENSE and then LICENSE.md from GitHub's raw host and verifies an MIT license", async () => {
		const script = fetchScript({
			"https://raw.githubusercontent.com/example/project/HEAD/LICENSE.md": { status: 200, body: "MIT License\n\n…" },
		})

		expect(await verifySourceURL(script.fetch, "https://github.com/example/project")).toBe("verified")

		expect(script.requested).toEqual([
			"https://raw.githubusercontent.com/example/project/HEAD/LICENSE",
			"https://raw.githubusercontent.com/example/project/HEAD/LICENSE.md",
		])
	})

	it("reads <url>/LICENSE on another host and verifies the Apache license", async () => {
		const script = fetchScript({
			"https://example.org/project/LICENSE": { status: 200, body: "Apache License\nVersion 2.0" },
		})

		expect(await verifySourceURL(script.fetch, "https://example.org/project/")).toBe("verified")
		expect(script.requested).toEqual(["https://example.org/project/LICENSE"])
	})

	it("is unverified for a 404 and for a body that names no compatible license", async () => {
		expect(await verifySourceURL(fetchScript({}).fetch, "https://github.com/example/absent")).toBe("unverified")

		const proprietary = fetchScript({
			"https://raw.githubusercontent.com/example/closed/HEAD/LICENSE": { status: 200, body: "All rights reserved." },
		})

		expect(await verifySourceURL(proprietary.fetch, "https://github.com/example/closed")).toBe("unverified")
	})

	it("is unverified when the fetch itself fails", async () => {
		const failing = (async () => {
			throw new TypeError("fetch failed")
		}) as unknown as typeof fetch

		expect(await verifySourceURL(failing, "https://github.com/example/project")).toBe("unverified")
	})
})
