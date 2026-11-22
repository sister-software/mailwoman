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
import { ReservationUse, SOURCE_RESERVATION_SCOPE, type SourceReservation } from "#reservation"
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
	sources: [{ sourceID: "a" }, { sourceID: "b" }, { sourceID: "s" }],
})

const reservation: SourceReservation = {
	use: ReservationUse.Evaluation,
	scope: SOURCE_RESERVATION_SCOPE,
	since: "2026-11-22",
	because: "a permanent confirmation pool, unseen by every model",
	issue: 1,
}

const reserved = (recorded: SourceReservation, ...licenses: LicenseDecision<SourceOperation>[]): LicenseRegister => ({
	...registerOf(...licenses),
	sources: [{ sourceID: "s", reservation: recorded }],
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

	it("refuses every action that requires train over a reserved source, quoting the reservation's reason", () => {
		for (const action of [LicenseAction.Ingest, LicenseAction.Train]) {
			const answer = ask(reserved(reservation, everyOperation), action)

			expect(answer.verdict, action).toBe(DecisionVerdict.NoGo)
			expect(answer.path.at(-1)).toMatchObject({ node: DecisionNode.Reservation, because: reservation.because })

			expect(answer.sources[0]!.problems).toEqual([
				"s is reserved for evaluation since 2026-11-22 (#1): a permanent confirmation pool, unseen by every model",
			])
		}

		// A model release and a served layer perform no train operation,
		// so a reservation leaves them to the operations node.
		for (const action of [LicenseAction.ReleaseModel, LicenseAction.ServeAddressLayer]) {
			expect(ask(reserved(reservation, everyOperation), action).verdict, action).toBe(DecisionVerdict.Go)
		}
	})

	it("passes a source whose reservation was lifted", () => {
		const lifted = {
			...reservation,
			lifted: { at: "2026-12-01", because: "the pool is retired", issue: 2, retires: ["heldout-x"] },
		}

		const answer = ask(reserved(lifted, everyOperation), LicenseAction.Train)

		expect(answer.verdict).toBe(DecisionVerdict.Go)
		expect(answer.path.find((step) => step.node === DecisionNode.Reservation)!.because).toMatch(/lifted on 2026-12-01/u)
	})

	it("reads a source the register's source list lacks as unknown at the reservation node", () => {
		const answer = evaluateLicense(
			{ action: LicenseAction.Train, offering: null, sources: [{ source: "unlisted", licenseID: "open" }] },
			registerOf(everyOperation)
		)

		expect(answer.verdict).toBe(DecisionVerdict.Unknown)
		expect(answer.path.at(-1)!.node).toBe(DecisionNode.Reservation)
	})

	it("reserves a source by its terms only when the request asks", () => {
		const refusesTraining: ElectedLicense<SourceOperation> = {
			...everyOperation,
			operations: {
				...everyOperation.operations,
				train: { permission: OperationPermission.Refused, because: "§4 forbids model training" },
			},
		}

		const request = { action: LicenseAction.Train, offering: null, sources: [{ source: "s", licenseID: "open" }] }

		const byTerms = evaluateLicense({ ...request, reservedByTerms: true }, registerOf(refusesTraining))
		const unflagged = evaluateLicense(request, registerOf(refusesTraining))

		expect(byTerms.path.at(-1)!.node).toBe(DecisionNode.Reservation)
		expect(byTerms.sources[0]!.problems[0]).toMatch(/reserved for evaluation by its terms/u)
		expect(unflagged.path.at(-1)!.node).toBe(DecisionNode.Operations)
	})

	it("never refuses on an obligation, an indemnity included", () => {
		// The 2026-11-21 NAD reading refused a source for its indemnity clause.
		// An indemnity allocates liability and restricts no use, so the decision's
		// operations decide the verdict whatever the source owes.
		const actions = Object.values(LicenseAction)

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
