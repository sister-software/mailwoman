// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { LicenseAction } from "#actions"
import {
	type ElectedLicense,
	type LicenseDecision,
	LicenseReviewState,
	ObligationStrength,
	OperationPermission,
	PermissionBasis,
	TermsStatement,
} from "#decision"
import { LicenseObligation } from "#obligations"
import { SourceOperation } from "#operations"
import { DecisionNode, evaluateLicense, type LicenseRegister, DecisionVerdict } from "#tree"

const permits = (because: string) => ({
	permission: OperationPermission.Permitted,
	basis: PermissionBasis.PublisherGrant,
	because,
})

/**
 * A decision permitting every operation, as a grant like CC BY 4.0 does.
 */
const everyOperation: ElectedLicense<SourceOperation> = {
	licenseID: "open",
	state: LicenseReviewState.Elected,
	electedTerms: "CC BY 4.0",
	spdx: "CC-BY-4.0",
	retrievedCopy: "licenses/cc-by-4.0.txt",
	electedBecause: "The publisher offers one grant.",
	operations: Object.fromEntries(Object.values(SourceOperation).map((operation) => [operation, permits("§2(a)")])),
}

const registerOf = (...licenses: LicenseDecision<SourceOperation>[]): LicenseRegister => ({
	contentDigest: "digest",
	licenses,
})

const SOLD = "AGPL-3.0-only OR LicenseRef-Commercial"

const ask = (register: LicenseRegister, action: LicenseAction, licenseID = "open") =>
	evaluateLicense({ action, offering: SOLD, sources: [{ source: "s", licenseID }] }, register)

describe("evaluateLicense", () => {
	it("reads an undeclared decision as unknown at the registered node", () => {
		const answer = ask(registerOf(), LicenseAction.Ingest, "missing")

		expect(answer.verdict).toBe(DecisionVerdict.Unknown)
		expect(answer.path.map((step) => step.node)).toEqual([DecisionNode.Registered])
		expect(answer.sources[0]!.problems).toEqual(['license "missing" is not declared in the register'])
	})

	it("reads a refused decision as no-go, quoting the publisher's words", () => {
		const answer = ask(
			registerOf({
				licenseID: "open",
				state: LicenseReviewState.Refused,
				refusedBecause: "The terms forbid redistribution.",
				reading: {
					url: "https://example.invalid/terms",
					found: TermsStatement.Terms,
					quote: "You may not redistribute.",
				},
			}),
			LicenseAction.ServeAddressLayer
		)

		expect(answer.verdict).toBe(DecisionVerdict.NoGo)
		expect(answer.path.at(-1)).toMatchObject({ node: DecisionNode.ReviewState, quote: "You may not redistribute." })
	})

	it("reads every node of a decision that permits each operation, owing what its terms and identifier record", () => {
		const answer = ask(registerOf(everyOperation), LicenseAction.ReleaseModel)

		expect(answer.verdict).toBe(DecisionVerdict.Go)
		expect(answer.registerDigest).toBe("digest")

		expect(answer.path.map((step) => [step.node, step.operation ?? null])).toEqual([
			[DecisionNode.Registered, null],
			[DecisionNode.ReviewState, null],
			[DecisionNode.Reservation, null],
			[DecisionNode.Operations, SourceOperation.RedistributeModel],
			[DecisionNode.Operations, SourceOperation.CommercialSublicense],
			[DecisionNode.Purpose, null],
			[DecisionNode.BasisFloor, null],
			[DecisionNode.Obligations, null],
		])

		expect(answer.owed).toEqual([
			{
				source: "s",
				obligation: LicenseObligation.Attribution,
				strength: ObligationStrength.Required,
				quote: null,
				identifier: "CC-BY-4.0",
			},
		])
	})

	it("performs commercial-sublicense only for an offering sold under the commercial terms", () => {
		const open = evaluateLicense(
			{ action: LicenseAction.ReleaseModel, offering: "AGPL-3.0-only", sources: [{ source: "s", licenseID: "open" }] },
			registerOf(everyOperation)
		)

		expect(open.path.flatMap((step) => step.operation ?? [])).toEqual([SourceOperation.RedistributeModel])
	})

	it("reads a permission for an operation the action forbids as no-go", () => {
		const answer = ask(registerOf(everyOperation), LicenseAction.EvaluateOnly)

		expect(answer.verdict).toBe(DecisionVerdict.NoGo)
		expect(answer.sources[0]!.problems).toEqual(["s's decision permits train, so its rows can reach a training corpus"])
	})

	it("answers the same for the same request in any source order", () => {
		const sources = [
			{ source: "b", licenseID: "open" },
			{ source: "a", licenseID: "missing" },
		]

		const register = registerOf(everyOperation)
		const forward = evaluateLicense({ action: LicenseAction.Train, offering: null, sources }, register)

		const reversed = evaluateLicense(
			{ action: LicenseAction.Train, offering: null, sources: sources.toReversed() },
			register
		)

		expect(reversed).toEqual(forward)
		expect(forward.sources.map((source) => source.source)).toEqual(["a", "b"])
		expect(forward.verdict).toBe(DecisionVerdict.Unknown)
	})

	it("never refuses on an obligation, an indemnity included", () => {
		// The 2026-11-21 NAD reading refused a source for its indemnity clause.
		// An indemnity allocates liability and restricts no use, so the decision's
		// operations decide the verdict whatever the source owes.
		const actions = Object.values(LicenseAction).filter((action) => action !== LicenseAction.EvaluateOnly)

		for (const obligation of Object.values(LicenseObligation)) {
			for (const strength of Object.values(ObligationStrength)) {
				const owing: ElectedLicense<SourceOperation> = {
					...everyOperation,
					obligations: [{ obligation, strength, quote: "The user shall hold the publisher harmless." }],
				}

				for (const action of actions) {
					const answer = ask(registerOf(owing), action)

					expect(answer.verdict, `${action} ${obligation} ${strength}`).toBe(DecisionVerdict.Go)
					expect(answer.owed).toContainEqual(expect.objectContaining({ obligation, strength }))
				}
			}
		}
	})
})
