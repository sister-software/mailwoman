/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { dispatch, parseOptions } from "@mailwoman/ops-cli"
import { describe, expect, it } from "vitest"

function io() {
	const out: string[] = []
	const err: string[] = []

	return {
		out,
		err,
		io: {
			stdout: (t: string) => void out.push(t),
			stderr: (t: string) => void err.push(t),
			repoRoot: "/repo",
			trackedFiles: async () => [],
		},
	}
}

describe("mwops dispatch", () => {
	it("prints usage and exits 2 without a verb, naming both registries", async () => {
		const h = io()

		expect(await dispatch([], h.io)).toBe(2)
		expect(h.err.join("")).toContain("release operations:")
		expect(h.err.join("")).toContain("health checks:")
	})

	it("refuses an unregistered release operation with the registered list", async () => {
		const h = io()

		expect(await dispatch(["release", "nope"], h.io)).toBe(2)
		expect(h.err.join("")).toContain('no operation "nope"')
	})

	it("refuses an unknown health check", async () => {
		const h = io()

		expect(await dispatch(["health", "nope"], h.io)).toBe(2)
	})

	it("refuses a baseline target other than debt without writing anything", async () => {
		const h = io()

		expect(await dispatch(["health", "baseline", "nope"], h.io)).toBe(2)
		expect(h.err.join("")).toContain('no baseline "nope"')
	})

	it("parses --key value, --key=value and bare flags, leaving values as strings for the schema", () => {
		expect(parseOptions(["plan", "--json", "--version", "9.3.0", "--out=x.json", "--dry-run"])).toEqual({
			options: { json: true, version: "9.3.0", out: "x.json", "dry-run": true },
			rest: ["plan"],
		})
	})
})
