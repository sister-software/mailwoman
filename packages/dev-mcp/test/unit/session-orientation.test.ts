/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * @file The orientation listing is injected at the top of every session, so its SIZE is part of its contract: a
 *   listing that displaces the work it serves is worse than none. The budget below is the one the design rests on.
 */

import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { repoRootPath } from "@mailwoman/core/paths"
import { orientationListing } from "@mailwoman/dev-mcp/hooks/session-orientation"
import { beforeAll, describe, expect, it } from "vitest"

import { runHook } from "../hook-harness.ts"

const HOOK = resolvePackagePath("@mailwoman/dev-mcp", "lib", "hooks", "session-orientation.ts")
const REPO_ROOT = String(repoRootPath())

/**
 * Roughly 2,500 tokens at four bytes each. The signature digest this replaces measured near 88,000 tokens for the same
 * tree, and would not survive a compaction; if the listing grows past this, drop the per-workspace subpath limit rather
 * than the budget.
 */
const BYTE_BUDGET = 10_000

let listing: string

beforeAll(async () => {
	listing = await orientationListing(REPO_ROOT)
})

describe("orientationListing", () => {
	it("names every workspace", () => {
		// oxlint-disable-next-line mailwoman/prefer-spliterator -- one listing, already resident and bounded by the budget.
		const lines = listing.split("\n").filter((line) => line.includes(": "))

		expect(lines.length).toBeGreaterThanOrEqual(70)
		expect(listing).toContain("@mailwoman/core:")
		expect(listing).toContain("@mailwoman/dev-mcp (private):")
	})

	it("carries the subpaths a consumer may import, and no wildcard patterns", () => {
		expect(listing).toContain("@mailwoman/formatter: . ./format ./key")
		expect(listing).not.toContain("./*")
	})

	it("counts the remainder rather than listing a large package in full", () => {
		// `@mailwoman/core` exports around a hundred subpaths; the listing is an index of where to look, and the rest of
		// them are what `mwdev_symbol` answers.
		expect(listing).toMatch(/@mailwoman\/core: \. .* \+\d+ more/u)
	})

	it("stays inside the injection budget", () => {
		expect(listing.length).toBeLessThan(BYTE_BUDGET)
	})

	it("points at the tool that answers what the listing does not", () => {
		expect(listing).toContain("mwdev_symbol")
	})
})

describe("the hook around the listing", () => {
	it("answers SessionStart context on stdout", () => {
		const output = runHook(HOOK, { hook_event_name: "SessionStart", source: "startup" })

		expect(output.hookSpecificOutput?.hookEventName).toBe("SessionStart")
		expect(output.hookSpecificOutput?.additionalContext).toContain("@mailwoman/core:")
	})
})
