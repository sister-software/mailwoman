/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { scopesByDiff } from "#repo-health/actions-output"

const BASE = "a".repeat(40)
const HEAD = "b".repeat(40)
const cloneHolds = async () => true
const cloneLacks = async () => false

describe("scopesByDiff", () => {
	it("scopes a pull request, and refuses one that does not name both commits", async () => {
		await expect(scopesByDiff("pull_request", BASE, HEAD, cloneLacks)).resolves.toBe(true)
		await expect(scopesByDiff("pull_request", "", HEAD, cloneHolds)).rejects.toThrow(/requires valid/u)
	})

	it("scopes a push by the commits it brought when the clone holds the previous head", async () => {
		await expect(scopesByDiff("push", BASE, HEAD, cloneHolds)).resolves.toBe(true)
	})

	it("runs every suite for a new branch, a force-push and a dispatch", async () => {
		await expect(scopesByDiff("push", "0".repeat(40), HEAD, cloneHolds)).resolves.toBe(false)
		await expect(scopesByDiff("push", BASE, HEAD, cloneLacks)).resolves.toBe(false)
		await expect(scopesByDiff("workflow_dispatch", undefined, undefined, cloneHolds)).resolves.toBe(false)
	})
})
