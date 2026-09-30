/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * @file The orientation listing is injected at the top of every session, so its size is part of its interface: a
 *   listing that displaces the work it serves is worse than none. The budget below is the one the design rests on.
 */

import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { repoRootPathBuilder } from "@mailwoman/core/paths"
import { beforeAll, describe, expect, it } from "vitest"

import { orientationListing } from "#hooks/session-orientation"
import { runHook } from "#test/hook-harness"

const HOOK = resolvePackagePath("@mailwoman/dev-mcp", "lib", "hooks", "session-orientation.ts")
const REPO_ROOT = repoRootPathBuilder()

/**
 * Roughly 2,500 tokens at four bytes each.
 *
 * The signature digest measured near 88,000 tokens for the same tree.
 * That output would not survive a compaction.
 *
 * If the listing grows past this, drop the per-workspace subpath limit rather than the budget.
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
		expect(listing).toContain("@mailwoman/record: . ./address ./name ./organization")
		expect(listing).not.toContain("./*")
	})

	it("counts the remainder rather than listing a large package in full", () => {
		// `@mailwoman/core` exports around a hundred subpaths.
		// The listing indexes where to look.
		// `mwdev_symbol` answers questions about the remaining subpaths.
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
