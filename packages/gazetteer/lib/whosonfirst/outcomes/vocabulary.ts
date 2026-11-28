// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { OutcomeVocabularyLike } from "@mailwoman/core/resolver/outcome"

import { OUTCOME_KINDS } from "#whosonfirst/outcomes/kinds"

/**
 * The outcome vocabulary as a geocode request is checked against it:
 * each kind's `mw:id`, name and facet, in `mw:id` order.
 *
 * It is computed once at import from the generated `OUTCOME_KINDS` table.
 * That table is fixed at runtime.
 */
export const OUTCOME_VOCABULARY: readonly OutcomeVocabularyLike[] = Object.entries(OUTCOME_KINDS).map(
	([name, kind]) => ({ id: kind.id, name, facet: kind.facet })
)
