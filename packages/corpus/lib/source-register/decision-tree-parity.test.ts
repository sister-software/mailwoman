// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Holds `@mailwoman/license`'s decision tree to the five operation lists it replaced,
 * over every decision in the committed register.
 *
 * The oracle is the replaced implementation: `operationProblems` over each hand-written list.
 * Each decision is read for an unreserved source, so the `reservation` node passes it.
 *
 * The evaluation-only reading no longer checks that the decision leaves `train` unpermitted:
 * a source's reservation keeps its rows out of training.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { LicenseAction } from "@mailwoman/license/actions"
import { type LicenseDecision, operationProblems } from "@mailwoman/license/decision"
import { SourceOperation } from "@mailwoman/license/operations"
import { evaluateLicense, DecisionVerdict } from "@mailwoman/license/tree"
import { describe, expect, it } from "vitest"

import { readAddressSourceRegister } from "#source-register/register"

/**
 * The four lists the action table replaced, as they were written.
 */
const REPLACED_LISTS: Readonly<Record<Exclude<LicenseAction, "evaluate-only">, readonly SourceOperation[]>> = {
	[LicenseAction.Ingest]: [
		SourceOperation.Fetch,
		SourceOperation.Extract,
		SourceOperation.Transform,
		SourceOperation.Train,
	],
	[LicenseAction.Train]: [SourceOperation.Transform, SourceOperation.Train],
	[LicenseAction.ReleaseModel]: [SourceOperation.RedistributeModel, SourceOperation.CommercialSublicense],
	[LicenseAction.ServeAddressLayer]: [SourceOperation.Fetch, SourceOperation.Extract, SourceOperation.RedistributeData],
}

/**
 * The fifth, the inline list `evaluationSourceProblems` read.
 */
const REPLACED_EVALUATION_LIST = [SourceOperation.Fetch, SourceOperation.Extract, SourceOperation.Transform]

const SOURCE = "parity-source"

function oracleProblems(action: LicenseAction, decision: LicenseDecision<SourceOperation>): string[] {
	const list = action === LicenseAction.EvaluateOnly ? REPLACED_EVALUATION_LIST : REPLACED_LISTS[action]

	return operationProblems(decision.licenseID, decision, list)
}

describe("the decision tree over the committed register", () => {
	it("answers go exactly where the replaced lists found no problem, with the same problems", async () => {
		const register = await readAddressSourceRegister()
		const actions = Object.values(LicenseAction)
		const mismatches: string[] = []

		for (const decision of register.licenses) {
			for (const action of actions) {
				const answer = evaluateLicense(
					{
						action,
						// The published models' expression, so a model release performs commercial-sublicense as the old list did.
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
