/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The contrast board's shape: rows grouped into arms whose expected labels are known.
 *
 *   A contrast row is `addressKind: "contrast"` with id `<cc>-contrast-<group>-<arm>`. Arms of one group
 *   share a surface form or an underlying address and differ in one contextual fact, so a contrast
 *   measures the group as a whole. Every arm is `status: pass`: the behavior is known, so a
 *   failure counts as a regression rather than sitting as a tracked target.
 */

import { describe, expect, it } from "vitest"

import { loadRegressionCases } from "#tools/eval-harness/gauntlet/cases/load"

const CONTRAST_ID = /^([a-z]{2})-contrast-([a-z0-9]+(?:-[a-z0-9]+)*?)-([a-z]+(?:-[a-z]+)*)$/u

/**
 * The groups the decoder-exposure plan requires, each with the arms that make it a contrast.
 */
const REQUIRED_GROUPS: Record<string, readonly string[]> = {
	"six-digit-postcode": ["in", "cn-native", "cn-latin", "ru-native", "ru-latin"],
	sector: ["planning-locality", "street"],
	block: ["premise-subdivision", "planning-locality"],
	script: ["native", "mixed", "omitted-level"],
}

describe("contrast board", async () => {
	const rows = (await loadRegressionCases()).filter((row) => row.addressKind === "contrast")

	it("names every contrast row by country, group and arm, and keeps every arm at status pass", () => {
		for (const row of rows) {
			expect(row.id, row.id).toMatch(CONTRAST_ID)
			expect(row.status, row.id).toBe("pass")
			expect(row.id.slice(0, 2), row.id).toBe(row.country.toLowerCase())
		}
	})

	it("holds every required group with its arms", () => {
		for (const [group, arms] of Object.entries(REQUIRED_GROUPS)) {
			for (const arm of arms) {
				expect(
					rows.some((row) => row.id.endsWith(`-contrast-${group}-${arm}`)),
					`${group}/${arm}`
				).toBe(true)
			}
		}
	})
})
