// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * `it-miur-scuole`: the education ministry's register of state schools as a corpus source.
 *
 * The adapter reads the register CSV through {@linkcode readMIURSchools}, the reader
 * the evaluation source of the same id calls, and renders each school site's street,
 * house number, postcode and comune in the ministry's capitals.
 * The school's name is never read into a row.
 * A street line without a house number yields no row.
 *
 * IODL 2.0 grants `estrarre e reimpiegare le Informazioni` and `creare un Lavoro derivato`,
 * on condition of naming the source and the provider (`data/licenses/it-miur-iodl-2.0.md`).
 */

import { createEvaluationCorpusAdapter } from "#evaluation/corpus-adapter"
import { itMIURScuoleSource, readMIURSchools } from "#it/evaluation/miur-scuole"
import { SourceRegister } from "#registers"
import { AddressRole } from "#types"

/**
 * Registry id for this adapter, stamped into every row it emits, and the evaluation source's id.
 */
export const IT_MIUR_SCUOLE_ADAPTER_ID = "it-miur-scuole"

/**
 * The registered `it-miur-scuole` adapter.
 */
export const itMIURScuoleAdapter = createEvaluationCorpusAdapter({
	id: IT_MIUR_SCUOLE_ADAPTER_ID,
	source: itMIURScuoleSource,
	register: SourceRegister.MIURScuole,
	locale: "it-IT",
	addressRole: AddressRole.Facility,
	description:
		"Ministero dell'Istruzione e del Merito's state-school register (IODL 2.0): each school site's street address, without its name.",
	read: readMIURSchools,
})
