// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   What a geocode adds for a request's `outcomeHint` and `outcomeFilter`: the checked
 *   request the resolver reads, and the advisories and fields the result reports.
 *
 *   `docs/engineering/reference/outcome-kinds.mdx` is the design.
 */

import { walkNodes, type AddressNode, type AddressTree } from "@mailwoman/core/decoder"
import type { GeocodeResult } from "@mailwoman/core/geocode"
import type { OutcomeKind } from "@mailwoman/core/outcome/kinds"
import { QueryIntentCode, type QueryIntentMarker, type QueryKind } from "@mailwoman/core/pipeline"
import {
	hasOutcomeOptions,
	type OutcomeMembership,
	type OutcomeOptions,
	outcomesSatisfy,
	parseOutcomeOptions,
	type ResolveOutcome,
} from "@mailwoman/core/resolver/outcome"
import { OUTCOME_SET_KEY, OUTCOME_TARGET_KEY } from "@mailwoman/resolver/outcome/fetch"

/**
 * The outcome head's identity top levels for a parse, most probable first, or null
 * when the loaded model has no outcome head.
 *
 * The parse holds no head distribution on this tree shape, so every parse reads null
 * and a response states `outcome_hint_model: "unsupported"`.
 * The model lane's `AddressTree.outcomeDistribution` is the value this reads once it lands.
 */
export function outcomeHeadOrderOf(_tree: AddressTree): readonly OutcomeKind[] | null {
	return null
}

/**
 * The query kind whose candidates the head's order may group without a hint.
 */
const HEAD_ORDERED_KIND: QueryKind = "bare_toponym"

/**
 * The request's outcome fields checked against the vocabulary, as the resolver reads them.
 *
 * It's null when the request sets neither field and the head's order doesn't apply.
 *
 * The head's order is read only without a hint, with the opt-in switch on, for a bare name
 * or a leading span whose decode wrote a small-margin runner-up to its `interpretations`.
 *
 * @throws {OutcomeRequestError} For an id outside the vocabulary or a hint the filter excludes.
 */
export function resolveOutcomeFor(
	options: OutcomeOptions | undefined,
	deps: {
		/**
		 * The head's identity top levels for this parse, most probable first, or null
		 * when the loaded model has no outcome head.
		 */
		headOrder: readonly OutcomeKind[] | null
		headOrdering: boolean
	},
	query: { kind: QueryKind; interpretedSpan: boolean }
): ResolveOutcome | null {
	// A JavaScript caller can pass any string, so the request is checked whatever its static type.
	const checked = options && hasOutcomeOptions(options) ? parseOutcomeOptions(options) : null
	const hint = checked?.outcomeHint ?? null
	const shapeEligible = query.kind === HEAD_ORDERED_KIND || query.interpretedSpan
	const headEligible = hint == null && deps.headOrdering && !!deps.headOrder?.length && shapeEligible

	if (!checked && !headEligible) return null

	return {
		hint,
		filter: checked?.outcomeFilter ? [...checked.outcomeFilter] : null,
		headOrder: headEligible ? deps.headOrder : null,
	}
}

/**
 * The span the resolver ordered by outcome, with the outcome set of the place it holds,
 * or null when the span resolved to no place.
 */
function orderedSpan(tree: AddressTree): { node: AddressNode; outcomes: readonly OutcomeMembership[] } | null {
	for (const node of walkNodes(tree.roots)) {
		if (node.metadata?.[OUTCOME_TARGET_KEY] === true && typeof node.placeID === "string") {
			return { node, outcomes: (node.metadata[OUTCOME_SET_KEY] as readonly OutcomeMembership[] | undefined) ?? [] }
		}
	}

	return null
}

function marker(kind: QueryKind, code: QueryIntentCode, message: string, evidence: Record<string, unknown>) {
	return { kind, code, mechanism: "outcome:request", message, evidence } satisfies QueryIntentMarker
}

/**
 * Applies the outcome request to a result.
 *
 * A filter whose span resolved to no admitted place answers zero places,
 * from `unresolved`, and never an unfiltered answer.
 * A hint the answer doesn't satisfy adds `outcome_hint_unsatisfied`.
 * The result always states `outcome_hint_model`.
 */
export function applyOutcomeResult(
	result: GeocodeResult,
	resolved: AddressTree,
	outcome: ResolveOutcome,
	context: { kind: QueryKind; headLoaded: boolean; unresolved: () => GeocodeResult }
): GeocodeResult {
	const span = orderedSpan(resolved)
	let answered = result

	if (outcome.filter && !(span && outcomesSatisfy(outcome.filter, span.outcomes))) {
		answered = context.unresolved()

		answered.intent_markers = [
			...answered.intent_markers,
			marker(
				context.kind,
				QueryIntentCode.OutcomeFilterEmpty,
				`The filter [${outcome.filter.join(", ")}] admitted zero candidates, so the result holds zero places.`,
				{ filter: outcome.filter }
			),
		]
	} else if (outcome.hint != null && !(span && outcomesSatisfy([outcome.hint], span.outcomes))) {
		answered.intent_markers = [
			...answered.intent_markers,
			marker(
				context.kind,
				QueryIntentCode.OutcomeHintUnsatisfied,
				`The answer doesn't satisfy the hint "${outcome.hint}". The text's evidence decided it.`,
				{ hint: outcome.hint, answer_outcomes: (span?.outcomes ?? []).map((m) => m.outcome) }
			),
		]
	}

	answered.outcome_hint_model = context.headLoaded ? "applied" : "unsupported"

	return answered
}
