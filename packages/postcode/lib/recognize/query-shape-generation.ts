// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The generation of the query-shape rules.
 *   A model card selects it with `requires.query_shape`.
 *
 *   The module imports no other module, so a reader of a model card holds no byte of the recognition engine.
 */

/**
 * The generation of the query-shape rules.
 *
 * - `legacy`: the thirteen hand-written postcode patterns, ten scripts
 *   and the accidental behaviors of the original classifier.
 *   Model 10.8.0 trained beside this generation.
 *   LEGACY-QUERY-SHAPE: delete this value and everything it selects when the first `postal` model ships.
 * - `postal`: postcode hits from the `postal` family, every Unicode script, and the specified behavior.
 */
export const QueryShapeGeneration = {
	Legacy: "legacy",
	Postal: "postal",
} as const

export type QueryShapeGeneration = (typeof QueryShapeGeneration)[keyof typeof QueryShapeGeneration]

/**
 * The generation a classifier or a router declares, or `legacy` when it declares none.
 *
 * A `ScriptRoutedClassifier` answers for its primary.
 */
export function queryShapeGenerationOf(holder: unknown): QueryShapeGeneration {
	const declared = (holder as { queryShapeGeneration?: unknown } | null | undefined)?.queryShapeGeneration

	return declared === QueryShapeGeneration.Postal ? QueryShapeGeneration.Postal : QueryShapeGeneration.Legacy
}
