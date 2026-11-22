// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   What a register row's decision records about redistributing that publisher's rows.
 *
 *   A served data layer copies a publisher's rows and redistributes them, so the reading is taken
 *   for `redistribute-data`, the operation serving performs, whatever else the decision permits.
 */

import {
	LicenseReviewState,
	OperationPermission,
	PermissionBasis,
	permissionFor,
	TermsStatement,
	type TermsObligation,
} from "@mailwoman/license/decision"
import { SourceOperation } from "@mailwoman/license/operations"

import type { RegisterDecisions } from "#source-register/corpus-inputs"
import type { AddressSourceRecord } from "#source-register/types"

/**
 * The ground a register row's decision gives for redistributing the publisher's rows.
 */
export const RegisterTermsBasis = {
	/**
	 * The publisher grants an open license, and the decision records its SPDX identifier.
	 */
	OpenLicense: "open-license",
	/**
	 * The publisher grants the rows under terms of its own.
	 *
	 * The decision records them in the publisher's words with no SPDX identifier.
	 */
	PublisherGrant: "publisher-grant",
	/**
	 * No publisher grant: the decision permits redistribution on a documented ground other
	 * than one, such as the US factual-data reading or a federal work under 17 U.S.C. § 105.
	 *
	 * The row's terms either state no restriction or state none at all.
	 * {@linkcode RegisterRowTerms.statement} records which.
	 */
	NoRestrictingTerms: "no-restricting-terms",
	/**
	 * A reviewer read the terms and refused the source, or the elected terms refuse redistribution.
	 */
	Refused: "refused",
	/**
	 * No reviewer has read the terms for redistribution: the decision is unchecked,
	 * or the elected terms don't state a permission for it.
	 */
	Unread: "unread",
	/**
	 * The register holds no row for the source, or the row points at a license without a decision.
	 */
	Unregistered: "unregistered",
} as const

export type RegisterTermsBasis = (typeof RegisterTermsBasis)[keyof typeof RegisterTermsBasis]

/**
 * The register fields {@linkcode registerRowTerms} reads.
 */
export interface RegisterTermsInput extends RegisterDecisions {
	sources: ReadonlyArray<Pick<AddressSourceRecord, "sourceID" | "license" | "publisher" | "name">>
}

/**
 * One register row's reading for redistribution.
 */
export interface RegisterRowTerms {
	registerSource: string
	/**
	 * The publisher as the register spells it, or `null` when the row names none.
	 */
	publisher: string | null
	licenseID: string | null
	/**
	 * The decision's review state, or `null` when the register has no decision for the row.
	 */
	decision: LicenseReviewState | null
	basis: RegisterTermsBasis
	spdx: string | null
	/**
	 * The elected terms in the publisher's words.
	 */
	electedTerms: string | null
	/**
	 * What the reviewer found on the terms page, or `null` when the decision records no structured reading.
	 *
	 * An elected open license or publisher grant reads `terms`, because a grant is a statement of terms.
	 * A `no-restricting-terms` row is the one whose finding this field separates.
	 */
	statement: TermsStatement | null
	termsURL: string | null
	/**
	 * The location of the reviewer's retained copy of the terms.
	 */
	retrievedCopy: string | null
	/**
	 * The obligations an elected decision records in the publisher's words, or `null` when it records none.
	 *
	 * An elected decision that refuses redistribution keeps them, so a refused
	 * row still shows what its terms ask.
	 */
	obligations: readonly TermsObligation[] | null
	/**
	 * The first sentence of the reason the decision gives for redistribution.
	 */
	because: string
}

const firstSentence = (text: string): string => text.split(/(?<=[.!?])\s/u, 1)[0]!

/**
 * Reads one register row's decision for redistributing its rows.
 *
 * A row the register lacks, or whose license has no decision, reads as unregistered
 * rather than as unread, because the register holds no record of a reading.
 */
export function registerRowTerms(register: RegisterTermsInput, registerSource: string): RegisterRowTerms {
	const row = register.sources.find((entry) => entry.sourceID === registerSource)
	const decision = row ? register.licenses.find((entry) => entry.licenseID === row.license) : undefined

	const base = {
		registerSource,
		publisher: row?.publisher ?? null,
		licenseID: row?.license ?? null,
		spdx: null,
		electedTerms: null,
		statement: null,
		termsURL: null,
		retrievedCopy: null,
		obligations: null,
	}

	if (!row || !decision) {
		return {
			...base,
			decision: null,
			basis: RegisterTermsBasis.Unregistered,
			because: row
				? `register row ${registerSource} points at license ${row.license}, which has no decision.`
				: `the register holds no row ${registerSource}.`,
		}
	}

	if (decision.state === LicenseReviewState.Unchecked) {
		return {
			...base,
			decision: decision.state,
			basis: RegisterTermsBasis.Unread,
			because: firstSentence(decision.note || decision.publisherStatement),
		}
	}

	const reading = {
		statement: decision.reading?.found ?? null,
		termsURL: decision.reading?.url ?? null,
		retrievedCopy: "retrievedCopy" in decision ? ((decision.retrievedCopy as string | undefined) ?? null) : null,
	}

	if (decision.state === LicenseReviewState.Refused) {
		return {
			...base,
			...reading,
			decision: decision.state,
			basis: RegisterTermsBasis.Refused,
			because: firstSentence(decision.refusedBecause),
		}
	}

	const redistribution = permissionFor(decision, SourceOperation.RedistributeData)

	const elected = {
		...base,
		...reading,
		decision: decision.state,
		obligations: decision.obligations ?? null,
		because: firstSentence(redistribution.because),
	}

	if (redistribution.permission === OperationPermission.Refused) {
		return { ...elected, basis: RegisterTermsBasis.Refused }
	}

	if (redistribution.permission !== OperationPermission.Permitted) {
		return { ...elected, basis: RegisterTermsBasis.Unread }
	}

	if (redistribution.basis === PermissionBasis.PublisherGrant) {
		return {
			...elected,
			// A grant is terms the publisher states.
			statement: TermsStatement.Terms,
			basis: decision.spdx ? RegisterTermsBasis.OpenLicense : RegisterTermsBasis.PublisherGrant,
			spdx: decision.spdx ?? null,
			electedTerms: decision.electedTerms,
		}
	}

	return { ...elected, basis: RegisterTermsBasis.NoRestrictingTerms, electedTerms: decision.electedTerms }
}
