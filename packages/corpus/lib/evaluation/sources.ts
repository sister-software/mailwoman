// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Every evaluation-only address source, in the order the evaluation-set builder reads them.
 *
 *   Each source's register decision refuses `train`, so no corpus build reads it.
 */

import { auACNCRegisterSource } from "#au/evaluation/acnc-register"
import { esSanidadCentrosAPSource } from "#es/evaluation/sanidad-centros-ap"
import type { EvaluationSource } from "#evaluation/source"
import { itMIURScuoleSource } from "#it/evaluation/miur-scuole"
import { nzCharitiesRegisterSource } from "#nz/evaluation/charities-register"

/**
 * The evaluation-only sources, one per country, that `heldout/fresh/build.ts` freezes rows from.
 */
export const EVALUATION_SOURCES: readonly EvaluationSource[] = [
	esSanidadCentrosAPSource,
	itMIURScuoleSource,
	auACNCRegisterSource,
	nzCharitiesRegisterSource,
]
