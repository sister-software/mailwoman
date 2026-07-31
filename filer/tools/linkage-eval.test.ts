/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for {@linkcode filerLinkageEval} (3b Task 4, decisions 3 & 4) — gate 4's two structural
 *   requirements live here: the truth field's absence from the matcher's input (asserted against the
 *   SAME `buildFilteredEvalInputs()` seam the eval itself calls, not a parallel copy), and
 *   reproducibility (running the eval twice reproduces identical scores and the identical input SHA).
 *   Runs the REAL `buildFilerDatabase`/`clusterFilers` pipeline end to end (a scratch on-disk `filer.db`,
 *   same discipline as `filer-lookup.test.ts`'s "REAL builder + REAL clusterAuthoritativeComponents"
 *   gate) — this suite is exercising the shipped linkage, not a stand-in for it.
 */

import { describe, expect, it } from "vitest"

import { toFRN } from "../sdk/frn.ts"
import {
	buildFilteredEvalInputs,
	buildLinkageEvalForm499Rows,
	buildTruthFamilyGroups,
	filerLinkageEval,
	hashLinkageEvalInputs,
} from "./linkage-eval.ts"

const FRN_CASCADE_1 = toFRN("9100000001")!
const FRN_CASCADE_2 = toFRN("9100000002")!
const FRN_CASCADE_3 = toFRN("9100000003")!
const FRN_MERIDIAN_1 = toFRN("9100000004")!
const FRN_MERIDIAN_2 = toFRN("9100000005")!
const FRN_NAMESAKE_1 = toFRN("9100000008")!
const FRN_NAMESAKE_2 = toFRN("9100000009")!

describe("buildFilteredEvalInputs — decision 4's leakage exclusion (gate 4)", () => {
	it("clears holdingCompany to an empty string on every Form499Row", () => {
		const { form499Rows } = buildFilteredEvalInputs()

		expect(form499Rows.length).toBeGreaterThan(0)

		for (const row of form499Rows) {
			expect(row.holdingCompany).toBe("")
		}
	})

	it("clears holdingCompany to null on every ProviderListRow", () => {
		const { providerRows } = buildFilteredEvalInputs()

		expect(providerRows.length).toBeGreaterThan(0)

		for (const row of providerRows) {
			expect(row.holdingCompany).toBeNull()
		}
	})

	it("leaves every OTHER field populated — this is a targeted redaction, not a blanked corpus", () => {
		const { form499Rows } = buildFilteredEvalInputs()

		for (const row of form499Rows) {
			expect(row.frn).not.toBeNull()
			expect(row.legalNameOfCarrier.length).toBeGreaterThan(0)
			expect(row.lastFiledAt.length).toBeGreaterThan(0)
		}
	})
})

describe("buildTruthFamilyGroups — the held-out ground truth", () => {
	it("collapses a spelling-drifted holding-company name onto the SAME truth family (Cascade, comma dropped)", () => {
		const truth = buildTruthFamilyGroups(buildLinkageEvalForm499Rows())

		expect(truth.get(FRN_CASCADE_1)).toBe(truth.get(FRN_CASCADE_2))
		expect(truth.get(FRN_CASCADE_2)).toBe(truth.get(FRN_CASCADE_3))
	})

	it("collapses a spelling-drifted holding-company name onto the SAME truth family (Meridian, comma added)", () => {
		const truth = buildTruthFamilyGroups(buildLinkageEvalForm499Rows())

		expect(truth.get(FRN_MERIDIAN_1)).toBe(truth.get(FRN_MERIDIAN_2))
	})

	it("never puts the two truth families in the same group", () => {
		const truth = buildTruthFamilyGroups(buildLinkageEvalForm499Rows())

		expect(truth.get(FRN_CASCADE_1)).not.toBe(truth.get(FRN_MERIDIAN_1))
	})

	it("gives two standalone filers with an IDENTICAL canonical legal name DIFFERENT truth groups — truth is holdingCompany, never legalNameOfCarrier", () => {
		const truth = buildTruthFamilyGroups(buildLinkageEvalForm499Rows())

		expect(truth.get(FRN_NAMESAKE_1)).not.toBe(truth.get(FRN_NAMESAKE_2))
	})
})

describe("hashLinkageEvalInputs", () => {
	it("is deterministic over the same inputs", () => {
		const inputs = buildFilteredEvalInputs()

		expect(hashLinkageEvalInputs(inputs)).toBe(hashLinkageEvalInputs(buildFilteredEvalInputs()))
	})

	it("changes when a matcher-visible field changes", () => {
		const inputs = buildFilteredEvalInputs()

		const mutated = {
			form499Rows: inputs.form499Rows.map((row, i) => (i === 0 ? { ...row, legalNameOfCarrier: "Mutated Co" } : row)),
			providerRows: inputs.providerRows,
		}

		expect(hashLinkageEvalInputs(mutated)).not.toBe(hashLinkageEvalInputs(inputs))
	})
})

describe("filerLinkageEval — reproducibility (gate 4)", () => {
	it("reproduces an identical score and input SHA across two independent runs", async () => {
		const first = await filerLinkageEval({ date: "2026-01-01" })
		const second = await filerLinkageEval({ date: "2026-01-01" })

		expect(second.score).toEqual(first.score)
		expect(second.inputsSHA256).toBe(first.inputsSHA256)
	})

	it("emits a markdown report — no embedded JSON, headed by a dated H1", async () => {
		const result = await filerLinkageEval({ date: "2026-01-01" })

		expect(result.markdown.startsWith("# 2026-01-01 — filer.db record linkage")).toBe(true)
		expect(result.markdown).toContain("## Results")
		expect(result.markdown).toContain(result.inputsSHA256)
		expect(result.markdown).not.toMatch(/[{[]"[a-zA-Z]/) // no inline JSON-object/array literal
	})
})

describe("filerLinkageEval — the actual finding (report this honestly, per the task brief)", () => {
	it(
		"the shipped linkage recovers ZERO of the held-out truth-positive family pairs — the identifier veto and the " +
			"relationship=same_entity filter structurally forbid a cross-FRN merge from name/identifier signal alone",
		async () => {
			const result = await filerLinkageEval({ date: "2026-01-01" })

			// 4 truth-positive pairs exist (Cascade: 3 choose 2 = 3; Meridian: 1) — see buildTruthFamilyGroups.
			expect(result.score.truthPositivePairs).toBe(4)
			expect(result.score.truePositivePairs).toBe(0)
			expect(result.score.predictedPositivePairs).toBe(0)
			expect(result.score.precision).toBeNull()
			expect(result.score.recall).toBe(0)
			expect(result.score.f1).toBe(0)
		}
	)
})
