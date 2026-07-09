/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Contract tests for `AddressTree.system` + the `containmentFor` indirection — the forward-compat
 *   anti-lock-in seam (DeepSeek resolver consult, 2026-05-30). These lock in two guarantees:
 *
 *   1. The discriminator round-trips: `buildAddressTree(..., { system })` stamps `tree.system`, and
 *        omitting it leaves `system` absent (the default Western path).
 *   2. It is currently BEHAVIOR-NEUTRAL: every system resolves to the same containment map, so the same
 *        tokens produce a structurally identical tree regardless of `system`. (When a distinct
 *        system map lands in Phase 6, that last guarantee is the one that intentionally changes —
 *        and this test is where the change must be made deliberately, not by accident.)
 */

import { describe, expect, test } from "vitest"

import type { BIOLabel } from "../types/component.ts"
import { buildAddressTree } from "./build-tree.ts"
import { containmentFor, PARENT_OF, WESTERN_PARENT_OF } from "./containment.ts"
import type { DecoderToken } from "./types.ts"
import { validateTree } from "./validate-tree.ts"

function tok(piece: string, start: number, end: number, label: BIOLabel): DecoderToken {
	return { piece, start, end, label, confidence: 1 }
}

const RAW = "1600 Pennsylvania Avenue NW, Washington, DC 20500"
function tokens(): DecoderToken[] {
	return [
		tok("1600", 0, 4, "B-house_number"),
		tok("Pennsylvania", 5, 17, "B-street"),
		tok("Avenue", 18, 24, "I-street"),
		tok("NW", 25, 27, "I-street"),
		tok("Washington", 29, 39, "B-locality"),
		tok("DC", 41, 43, "B-region"),
		tok("20500", 44, 49, "B-postcode"),
	]
}

/** Stable structural fingerprint: each node as `tag(value)` with nested children. */
function shape(nodes: { tag: string; value: string; children: unknown[] }[]): string {
	return nodes.map((n) => `${n.tag}[${shape(n.children as never)}]`).join(",")
}

describe("AddressTree.system + containmentFor", () => {
	test("system is absent by default", () => {
		const tree = buildAddressTree(RAW, tokens())
		expect(tree.system).toBeUndefined()
	})

	test("buildAddressTree stamps the requested system onto the tree", () => {
		expect(buildAddressTree(RAW, tokens(), { system: "western" }).system).toBe("western")
		expect(buildAddressTree(RAW, tokens(), { system: "japanese" }).system).toBe("japanese")
	})

	test("system is behavior-neutral today — identical structure regardless of system", () => {
		const base = shape(buildAddressTree(RAW, tokens()).roots as never)
		const western = shape(buildAddressTree(RAW, tokens(), { system: "western" }).roots as never)
		const japanese = shape(buildAddressTree(RAW, tokens(), { system: "japanese" }).roots as never)
		expect(western).toBe(base)
		expect(japanese).toBe(base)
	})

	test("containmentFor returns the Western map for every system today", () => {
		expect(containmentFor(undefined)).toBe(WESTERN_PARENT_OF)
		expect(containmentFor("western")).toBe(WESTERN_PARENT_OF)
		expect(containmentFor("japanese")).toBe(WESTERN_PARENT_OF)
	})

	test("PARENT_OF alias still points at the Western map (back-compat for existing imports)", () => {
		expect(PARENT_OF).toBe(WESTERN_PARENT_OF)
	})

	test("validateTree honors the tree's system (a valid Western tree stays valid when tagged)", () => {
		const tree = buildAddressTree(RAW, tokens(), { system: "western" })
		expect(validateTree(tree).valid).toBe(true)
	})
})
