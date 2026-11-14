// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import {
	type ElectedLicense,
	LicenseReviewState,
	type OperationDecision,
	OperationPermission,
	PermissionBasis,
} from "@mailwoman/core/license/decision"
import { describe, expect, it } from "vitest"

import { evaluationSourceProblems, stratumQuotas } from "#tools/eval-harness/heldout/fresh/build"

describe("stratumQuotas", () => {
	it("gives every stratum its floor and splits the rest by remaining supply, summing to the quota", () => {
		const supply = new Map([
			["big", 1000],
			["mid", 100],
			["tiny", 3],
		])

		const quotas = stratumQuotas(supply, 200, 20)

		expect([...quotas.values()].reduce((a, b) => a + b, 0)).toBe(200)
		expect(quotas.get("tiny")).toBe(3)
		expect(quotas.get("mid")!).toBeGreaterThanOrEqual(20)

		for (const [stratum, quota] of quotas) {
			expect(quota).toBeLessThanOrEqual(supply.get(stratum)!)
		}
	})

	it("takes every row when the supply is under the quota", () => {
		const supply = new Map([
			["a", 5],
			["b", 7],
		])

		expect(stratumQuotas(supply, 100, 20)).toEqual(supply)
	})
})

describe("evaluationSourceProblems", () => {
	const source = { id: "xx-eval", registerSource: "xx-src-1" }

	const register = (train: OperationPermission) => {
		const permitted: OperationDecision = {
			permission: OperationPermission.Permitted,
			basis: PermissionBasis.PublisherGrant,
			because: "x",
		}

		const decision: ElectedLicense = {
			licenseID: "lic",
			state: LicenseReviewState.Elected,
			electedTerms: "Terms",
			retrievedCopy: "terms.md",
			electedBecause: "x",
			operations: {
				fetch: permitted,
				extract: permitted,
				transform: permitted,
				train: { ...permitted, permission: train },
			},
		}

		return { sources: [{ sourceID: "xx-src-1", license: "lic" }], licenses: [decision] }
	}

	it("admits a source whose decision permits fetching and transforming and refuses training", () => {
		expect(evaluationSourceProblems(source, register(OperationPermission.Refused))).toEqual([])
	})

	it("refuses a source whose decision permits training, so its rows could reach a corpus", () => {
		expect(evaluationSourceProblems(source, register(OperationPermission.Permitted)).join("\n")).toMatch(
			/permits train/u
		)
	})
})
