// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Holds `@mailwoman/license`'s decision tree to hand-written operation and purpose lists,
 * over every decision in the committed register.
 *
 * The oracle is the list reading the tree replaced: `operationProblems` over each action's operations,
 * then one problem per purpose the decision doesn't permit, read from its `purposes` defaults.
 * Each decision is read for an unreserved source, so the `reservation` node passes it, and for
 * the published models' offering, so every action that delivers its result performs `sale`.
 */

import { stringifyJSON } from "@mailwoman/core/values/json"
import { LicenseAction } from "@mailwoman/license/actions"
import {
	LicenseReviewState,
	type LicenseDecision,
	operationProblems,
	type OperationDecision,
	UsePurpose,
} from "@mailwoman/license/decision"
import { SourceOperation } from "@mailwoman/license/operations"
import { evaluateLicense, DecisionVerdict } from "@mailwoman/license/tree"
import { describe, expect, it } from "vitest"

import { readAddressSourceRegister } from "#source-register/register"

/**
 * What each action performs, as written by hand.
 */
const ACTION_LISTS: Readonly<Record<LicenseAction, readonly SourceOperation[]>> = {
	[LicenseAction.Ingest]: [
		SourceOperation.Fetch,
		SourceOperation.Extract,
		SourceOperation.Transform,
		SourceOperation.Train,
	],
	[LicenseAction.Train]: [SourceOperation.Transform, SourceOperation.Train],
	[LicenseAction.ReleaseModel]: [SourceOperation.DistributeModel],
	[LicenseAction.ServeAddressLayer]: [SourceOperation.Fetch, SourceOperation.Extract, SourceOperation.DistributeRows],
	[LicenseAction.Evaluate]: [
		SourceOperation.Fetch,
		SourceOperation.Extract,
		SourceOperation.Transform,
		SourceOperation.Evaluate,
	],
}

/**
 * The actions that hand their result to a recipient, so a sold offering makes them a sale.
 */
const DELIVERING: ReadonlySet<LicenseAction> = new Set([LicenseAction.ReleaseModel, LicenseAction.ServeAddressLayer])

const SOURCE = "parity-source"

function oracleProblems(action: LicenseAction, decision: LicenseDecision<SourceOperation>): string[] {
	const problems = operationProblems(decision.licenseID, decision, ACTION_LISTS[action])

	if (decision.state !== LicenseReviewState.Elected) return problems

	const purposes = DELIVERING.has(action) ? [UsePurpose.CommercialUse, UsePurpose.Sale] : [UsePurpose.CommercialUse]

	for (const purpose of purposes) {
		const reading: OperationDecision = decision.purposes?.[purpose] ?? {
			permission: "unreviewed",
			because: `the elected terms do not state whether ${purpose} is permitted`,
		}

		if (reading.permission !== "permitted") {
			problems.push(`the elected terms read ${reading.permission} for ${purpose}: ${reading.because}`)
		}
	}

	return problems
}

describe("the decision tree over the committed register", () => {
	it("answers go exactly where the hand-written lists find no problem, with the same problems", async () => {
		const register = await readAddressSourceRegister()
		const actions = Object.values(LicenseAction)
		const mismatches: string[] = []

		// The oracle reads purposes from their defaults only.
		const exceptions = register.licenses.filter(
			(decision) => decision.state === LicenseReviewState.Elected && decision.purposeExceptions
		)

		expect(exceptions.map((decision) => decision.licenseID)).toEqual([])

		for (const decision of register.licenses) {
			for (const action of actions) {
				const answer = evaluateLicense(
					{
						action,
						offering: "AGPL-3.0-only OR LicenseRef-Commercial",
						sources: [{ source: SOURCE, licenseID: decision.licenseID }],
					},
					{ contentDigest: register.contentDigest, licenses: [decision], sources: [{ sourceID: SOURCE }] }
				)

				const expected = oracleProblems(action, decision)
				const problems = answer.sources[0]!.problems

				if (
					(answer.verdict === DecisionVerdict.Go) !== (expected.length === 0) ||
					stringifyJSON(problems) !== stringifyJSON(expected)
				) {
					mismatches.push(`${action} ${decision.licenseID}`)
				}
			}
		}

		expect(register.licenses.length * actions.length).toBeGreaterThan(0)
		expect(mismatches).toEqual([])
	})
})
