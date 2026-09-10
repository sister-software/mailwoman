/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { repoRootPath } from "@mailwoman/core/paths"
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

	it("refuses a fix for a check that has none, naming the ones that do", async () => {
		const h = io()

		expect(await dispatch(["health", "fix", "nope"], h.io)).toBe(2)
		expect(h.err.join("")).toContain('no fix for "nope"')
		expect(h.err.join("")).toContain("prefix-directories")
	})

	it("reports nothing to move when the check already passes", async () => {
		const h = io()
		// A real root, because the fix reads the `workspaces` field to know which directory names are package names.
		// The tracked-file list stays empty, so there is no repeated prefix and the fix plans no move.
		const withRealRoot = { ...h.io, repoRoot: String(repoRootPath()) }

		expect(await dispatch(["health", "fix", "prefix-directories"], withRealRoot)).toBe(0)
		expect(h.out.join("")).toContain("nothing to move")
	})

	it("parses --key value, --key=value and bare flags, leaving values as strings for the schema", () => {
		expect(parseOptions(["plan", "--json", "--version", "9.3.0", "--out=x.json", "--dry-run"])).toEqual({
			options: { json: true, version: "9.3.0", out: "x.json", "dry-run": true },
			rest: ["plan"],
		})
	})
})
