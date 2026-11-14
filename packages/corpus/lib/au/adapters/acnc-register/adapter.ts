// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * `au-acnc-register`: the ACNC charity register as a corpus source.
 *
 * The adapter reads `datadotgov_main.csv` through {@linkcode readACNCCharities},
 * the reader the evaluation source of the same id calls, and renders each charity's
 * single street line, town, state and postcode.
 * The charity's name is never read into a row, because a small charity's name can be
 * a person's and its address can be a responsible person's home.
 *
 * A withheld address, a post-office box and a multi-line address yield no row.
 *
 * CC BY 3.0 AU clause 3A grants the right to
 * `create and Reproduce one or more Derivative Works` (`data/licenses/au-acnc-cc-by-3.0-au.md`).
 */

import { auACNCRegisterSource, readACNCCharities } from "#au/evaluation/acnc-register"
import { createEvaluationCorpusAdapter } from "#evaluation/corpus-adapter"
import { SourceRegister } from "#registers"
import { AddressRole } from "#types"

/**
 * Registry id for this adapter, stamped into every row it emits, and the evaluation source's id.
 */
export const AU_ACNC_REGISTER_ADAPTER_ID = "au-acnc-register"

/**
 * The registered `au-acnc-register` adapter.
 */
export const auACNCRegisterAdapter = createEvaluationCorpusAdapter({
	id: AU_ACNC_REGISTER_ADAPTER_ID,
	source: auACNCRegisterSource,
	register: SourceRegister.ACNCRegister,
	locale: "en-AU",
	addressRole: AddressRole.RegisteredOffice,
	description: "ACNC Registered Charities (CC BY 3.0 AU): each charity's single-line street address, without its name.",
	read: readACNCCharities,
})
