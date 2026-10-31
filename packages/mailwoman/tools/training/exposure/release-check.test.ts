/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import {
	completedRun,
	type ExposureForms,
	loadFloors,
	claimFromArgument,
	preflight,
	refused,
	Verdict,
} from "./release/check.ts"

const report = (stage: string, forms: Record<string, number> | null): ExposureForms => ({
	jurisdictions: { RU: { phenomena: { "streetless-premise-identity": { [stage]: forms } } } },
})

const CLAIM = [["RU", "streetless-premise-identity"]] as const

describe("exposure release check", () => {
	test("the committed floors are empty until a curve sets one", async () => {
		await expect(loadFloors()).resolves.toEqual({})
	})

	test("the preflight refuses zero expected draws and reports an unmeasured stage", () => {
		expect(preflight(report("replayed_draws", {}), CLAIM)[0]!.verdict).toBe(Verdict.Refuse)
		expect(preflight(report("replayed_draws", { streetless: 40 }), CLAIM, 3)[0]!.exposure).toBe(120)
		expect(preflight(report("replayed_draws", null), CLAIM)[0]!.verdict).toBe(Verdict.Unmeasured)
	})

	test("the completed-run check reads realized draws only", () => {
		const floors = { "streetless-premise-identity": { floor: 1000, evidence: "exposure-curve-ru.json" } }

		// An expectation is not substituted for an unlogged realization.
		expect(completedRun(report("replayed_draws", { streetless: 5000 }), CLAIM, floors)[0]!.verdict).toBe(
			Verdict.Unmeasured
		)

		expect(completedRun(report("realized_draws", { streetless: 999 }), CLAIM, floors)[0]!.verdict).toBe(Verdict.Refuse)
		expect(completedRun(report("realized_draws", { streetless: 1000 }), CLAIM, floors)[0]!.verdict).toBe(Verdict.Pass)
		expect(completedRun(report("realized_draws", { streetless: 1 }), CLAIM, {})[0]!.verdict).toBe(Verdict.NoFloor)
	})

	test("a failing contrast arm refuses promotion", () => {
		const findings = completedRun(report("realized_draws", { streetless: 1 }), CLAIM, {}, [
			"ru-contrast-six-digit-postcode-ru-native",
		])

		expect(refused(findings)).toBe(true)
		expect(findings.at(-1)).toMatchObject({ jurisdiction: "RU", phenomenon: "contrast:six-digit-postcode-ru-native" })
	})

	test("a claim without a colon is refused", () => {
		expect(claimFromArgument("RU:streetless-premise-identity")).toEqual(["RU", "streetless-premise-identity"])
		expect(() => claimFromArgument("RU")).toThrow("CC:PHENOMENON")
	})
})
