/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the arena summary parser in promotion-gate-verdict.ts. The arena table shape changed when the #1151
 *   rules-parser deletion dropped the v0 comparison columns; `arenaColumn` must read the `neural` score by header on
 *   BOTH the pre- and post-#1151 shapes, so a gate run on the current tree stops misreading `fail` as `neural`.
 */

import { describe, expect, test } from "vitest"

import { arenaColumn } from "./promotion-gate-verdict.ts"

// Post-#1151: summarize-arenas.ts emits the neural-only shape. `neural` is the first %-column after n.
const NEURAL_ONLY = [
	"| arena | n | neural | fail | tree-valid |",
	"| --- | --: | --: | --: | --: |",
	"| libpostal | 69 | 33% | 67% | 100% |",
	"| perturb | 398 | 80% | 20% | 100% |",
	"| postal | 38 | 13% | 87% | 95% |",
].join("\n")

// Pre-#1151: the v0 comparison columns were present; `neural` is the second %-column after n.
const WITH_V0 = [
	"| arena | n | v0 | neural | both | neural-only | v0-only | both-fail | tree-valid |",
	"| --- | --: | --: | --: | --: | --: | --: | --: | --: |",
	"| libpostal | 69 | 29% | 32% | 19% | 13% | 10% | 58% | 100% |",
	"| perturb | 398 | 39% | 79% | 36% | 43% | 3% | 17% | 100% |",
	"| postal | 38 | 26% | 13% | 8% | 5% | 18% | 68% | 95% |",
].join("\n")

describe("arenaColumn", () => {
	test("reads the neural score from the post-#1151 neural-only table (not the fail column)", () => {
		expect(arenaColumn(NEURAL_ONLY, "perturb", "neural")).toBe(80)
		expect(arenaColumn(NEURAL_ONLY, "perturb", "fail")).toBe(20)
	})

	test("reads the neural score from the pre-#1151 v0-comparison table (column shifted right)", () => {
		expect(arenaColumn(WITH_V0, "perturb", "neural")).toBe(79)
		expect(arenaColumn(WITH_V0, "perturb", "v0")).toBe(39)
	})

	test("locates other arena rows and returns undefined for an absent column or row", () => {
		expect(arenaColumn(NEURAL_ONLY, "libpostal", "neural")).toBe(33)
		expect(arenaColumn(NEURAL_ONLY, "perturb", "nonexistent")).toBeUndefined()
		expect(arenaColumn(NEURAL_ONLY, "nonexistent", "neural")).toBeUndefined()
	})
})
