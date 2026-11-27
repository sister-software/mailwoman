// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A model's outcome classes, read from its card's `outcomes` block
 *   (`docs/engineering/reference/outcome-kinds.mdx`): the outcome ids the `outcome_hint` input's rows
 *   and the `outcome_logits` output's classes stand for, and the definitions revision they follow.
 */

import type { OutcomeProbability } from "@mailwoman/core/decoder"
import { stringifyJSON } from "@mailwoman/core/values/json"

import { softmax } from "#decode/viterbi"

/**
 * The card's `outcomes` block.
 */
export interface OutcomeTable {
	/**
	 * The `mailwoman/whosonfirst-outcomes` commit the classes follow, or `null` when the card pins none.
	 */
	revision: string | null
	/**
	 * The sha256 of that revision's compiled spec, or `null` when the card pins none.
	 */
	sha256: string | null
	/**
	 * The ids the hint embedding's rows stand for, in row order.
	 */
	hintClasses: readonly string[]
	/**
	 * The ids the outcome head's classes stand for, in class order.
	 */
	headClasses: readonly string[]
}

/**
 * The `outcome_hint` value that states no hint: the ONNX `Gather` reads −1 as the table's last row.
 */
export const NO_OUTCOME_HINT = -1

const isStrings = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((v) => typeof v === "string")

const nullableString = (value: unknown): value is string | null => value === null || typeof value === "string"

/**
 * Validates a model card's `outcomes` value.
 * It returns `null` when the card has no such field.
 *
 * @throws When the value is present but malformed.
 */
export function parseOutcomeTable(value: unknown, source: string): OutcomeTable | null {
	if (value == null) return null

	const block = value as Record<string, unknown>

	if (
		!isStrings(block.hint_classes) ||
		!isStrings(block.head_classes) ||
		!nullableString(block.revision ?? null) ||
		!nullableString(block.sha256 ?? null)
	) {
		throw new Error(
			`model card ${source} has a malformed \`outcomes\` field — expected {revision, sha256, hint_classes: ` +
				`string[], head_classes: string[]}, got ${stringifyJSON(value)}.`
		)
	}

	return {
		revision: (block.revision as string | null | undefined) ?? null,
		sha256: (block.sha256 as string | null | undefined) ?? null,
		hintClasses: block.hint_classes,
		headClasses: block.head_classes,
	}
}

/**
 * The `outcome_hint` row for a requested outcome id.
 *
 * An id the card lists maps to its row.
 * An id it doesn't list maps to its parent's row, the part before the dot,
 * and to {@linkcode NO_OUTCOME_HINT} when the parent is absent too.
 *
 * A role such as `landmark` is outside the hint classes and maps to no hint.
 */
export function outcomeHintID(table: OutcomeTable | null | undefined, outcome: string | null | undefined): number {
	if (!table || !outcome) return NO_OUTCOME_HINT

	const own = table.hintClasses.indexOf(outcome)

	if (own !== -1) return own

	const dot = outcome.indexOf(".")

	if (dot === -1) return NO_OUTCOME_HINT

	const parent = table.hintClasses.indexOf(outcome.slice(0, dot))

	return parent === -1 ? NO_OUTCOME_HINT : parent
}

/**
 * The outcome head's distribution over the card's head classes, in class order.
 *
 * @throws When the head's width differs from the card's class count.
 */
export function outcomeDistribution(table: OutcomeTable, logits: readonly number[]): OutcomeProbability[] {
	if (logits.length !== table.headClasses.length) {
		throw new Error(
			`the graph's outcome_logits has ${logits.length} classes and the card's outcomes.head_classes ` +
				`${table.headClasses.length}`
		)
	}

	const probabilities = softmax([...logits])

	return table.headClasses.map((outcome, i) => ({ outcome, probability: probabilities[i]! }))
}
