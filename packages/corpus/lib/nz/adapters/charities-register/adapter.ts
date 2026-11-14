// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * `nz-charities-register`: New Zealand's Charities Register as a corpus source.
 *
 * The adapter reads the OData answer `organisations.csv` through {@linkcode readNZCharities},
 * the reader the evaluation source of the same id calls, and renders each charity's
 * street line, suburb, city and postcode.
 * The fetch selects no name, officer or email column, so no row can join an address to
 * a person, though a small charity's street address can be an officer's home.
 *
 * A post-office box and a second line that isn't the city yield no row.
 *
 * CC BY 3.0 NZ grants the right to `create one or more Adaptations` (`data/licenses/nz-charities-cc-by-3.0-nz.md`).
 */

import { createEvaluationCorpusAdapter } from "#evaluation/corpus-adapter"
import { nzCharitiesRegisterSource, readNZCharities } from "#nz/evaluation/charities-register"
import { SourceRegister } from "#registers"
import { AddressRole } from "#types"

/**
 * Registry id for this adapter, stamped into every row it emits, and the evaluation source's id.
 */
export const NZ_CHARITIES_REGISTER_ADAPTER_ID = "nz-charities-register"

/**
 * The registered `nz-charities-register` adapter.
 */
export const nzCharitiesRegisterAdapter = createEvaluationCorpusAdapter({
	id: NZ_CHARITIES_REGISTER_ADAPTER_ID,
	source: nzCharitiesRegisterSource,
	register: SourceRegister.NZCharitiesRegister,
	locale: "en-NZ",
	addressRole: AddressRole.RegisteredOffice,
	description:
		"Charities Services' Charities Register (CC BY 3.0 NZ): each registered charity's street address, without its name.",
	read: readNZCharities,
})
