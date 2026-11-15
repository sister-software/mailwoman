// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * `es-sanidad-centros-ap`: the Ministerio de Sanidad's primary-care center catalogue as a corpus source.
 *
 * The adapter reads `SIAP_CENTROS.txt` inside the catalogue zip through
 * {@linkcode readSanidadCentres}, the reader the evaluation source of the same id calls,
 * and renders each center's street, house number, postcode and locality.
 * The center's name is never read into a row.
 * A street line without a house number (`S/N`) yields no row.
 *
 * The ministry's legal notice authorizes `reproducción total o parcial, modificación`
 * for commercial and non-commercial use, on condition of citing the source
 * and the date of its last update (`data/licenses/es-sanidad-aviso-legal.md`).
 */

import { esSanidadCentrosAPSource, readSanidadCentres } from "#es/evaluation/sanidad-centros-ap"
import { createEvaluationCorpusAdapter } from "#evaluation/corpus-adapter"
import { SourceRegister } from "#registers"
import { AddressRole } from "#types"

/**
 * Registry id for this adapter, stamped into every row it emits, and the evaluation source's id.
 */
export const ES_SANIDAD_CENTROS_AP_ADAPTER_ID = "es-sanidad-centros-ap"

/**
 * The registered `es-sanidad-centros-ap` adapter.
 */
export const esSanidadCentrosAPAdapter = createEvaluationCorpusAdapter({
	id: ES_SANIDAD_CENTROS_AP_ADAPTER_ID,
	source: esSanidadCentrosAPSource,
	register: SourceRegister.SanidadCentrosAP,
	locale: "es-ES",
	addressRole: AddressRole.Facility,
	description:
		"Ministerio de Sanidad's primary-care centre catalogue (aviso legal, reuse authorized): each centre's street address, without its name.",
	read: readSanidadCentres,
})
