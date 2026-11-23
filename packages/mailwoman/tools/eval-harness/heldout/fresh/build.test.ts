// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import {
	type ElectedLicense,
	LicenseReviewState,
	type OperationDecision,
	OperationPermission,
	PermissionBasis,
} from "@mailwoman/license/decision"
import { ReservationUse, SOURCE_RESERVATION_SCOPE, type SourceReservation } from "@mailwoman/license/reservation"
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

	const reservation: SourceReservation = {
		use: ReservationUse.Evaluation,
		scope: SOURCE_RESERVATION_SCOPE,
		since: "2026-11-22",
		because: "a confirmation pool",
		issue: 1,
	}

	const permitted: OperationDecision = {
		permission: OperationPermission.Permitted,
		basis: PermissionBasis.PublisherGrant,
		because: "x",
	}

	const register = (recorded?: SourceReservation, training: OperationDecision = permitted) => {
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
				evaluate: permitted,
				train: training,
			},
			purposes: { "commercial-use": permitted },
		}

		return {
			sources: [{ sourceID: "xx-src-1", license: "lic", ...(recorded ? { reservation: recorded } : {}) }],
			licenses: [decision],
		}
	}

	it("admits a reserved source no training manifest read, whatever its decision says of training", () => {
		expect(evaluationSourceProblems(source, register(reservation), new Map())).toEqual([])
	})

	it("admits a source its terms reserve: evaluate permitted and train refused", () => {
		const refused = { permission: OperationPermission.Refused, because: "no model training" }

		expect(evaluationSourceProblems(source, register(undefined, refused), new Map())).toEqual([])
	})

	it("refuses an unreserved source, a lifted reservation, and a source a training manifest read", () => {
		const lifted = { ...reservation, lifted: { at: "2026-12-01", because: "x", issue: 2, retires: [] } }

		expect(evaluationSourceProblems(source, register(), new Map())).toEqual([
			"xx-eval: register source xx-src-1 is not reserved for evaluation",
		])

		expect(evaluationSourceProblems(source, register(lifted), new Map()).join("\n")).toMatch(/lifted on 2026-12-01/u)

		expect(
			evaluationSourceProblems(source, register(reservation), new Map([["xx-src-1", new Set(["v0.8.22"])]]))
		).toEqual(["xx-eval: training manifest(s) v0.8.22 read register source xx-src-1"])
	})
})
