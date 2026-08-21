/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   What is this string MADE OF — mailwoman's reading against libpostal's, on the same input.
 *
 *   `mwdev_compare` grades geocoders on a coordinate, and libpostal produces none: it is a parser, not a geocoder, so
 *   an arm that scored it there would record a miss on every row at every threshold. It is also the only genuinely
 *   like-for-like PARSE comparison available — it is Pelias's parser, and `@mailwoman/libpostal` implements its exact
 *   `/parse` contract — which is why the question gets its own surface rather than a column in a distance table.
 *
 *   **Both sides are expressed in libpostal's label vocabulary, using the drop-in's own converter.** Mailwoman's tree
 *   goes through `treeToParseMatches` + `toLibpostalComponents`, the same pair `@mailwoman/libpostal` serves from, so
 *   the two readings are compared in one vocabulary and no inverse map is re-typed here.
 *
 *   That mapping is LOSSY AND MANY-TO-ONE, and every reading of this output depends on knowing it. `neighbourhood` and
 *   `dependent_locality` both become `suburb`; `macroregion` and `subregion` both become `state_district`; `venue` and
 *   `house` both become `house`; `intersection_a` and `intersection_b` both become `road`. So agreement on a LABEL is
 *   not agreement on a TAG, and the mailwoman side carries its original tag beside the mapped label rather than
 *   letting the collapse pass for consensus.
 *
 *   Values are compared case-folded because libpostal lowercases its output and mailwoman preserves the input's case;
 *   comparing raw would report a disagreement on every populated row and hide the real ones.
 *
 *   No winner is declared. Two parsers disagreeing says where to look, and the truth an input set carries is in
 *   mailwoman's tag vocabulary — grading libpostal against it would run the lossy map in the direction that loses.
 */

import { APIClient } from "@mailwoman/core/api"
import type { AddressTree } from "@mailwoman/core/decoder"
import { COMPONENT_TO_LIBPOSTAL, toLibpostalComponents, treeToParseMatches } from "@mailwoman/libpostal"

import { assertScorableEndpoint, EXTERNAL_ARM_MIN_REQUEST_INTERVAL_MS } from "./external-arm.ts"

const PARSE_TIMEOUT_MS = 15_000

export interface LabelledSpan {
	label: string
	value: string
	/**
	 * Mailwoman's own `ComponentTag` before the mapping, present on that side only. The label alone cannot say which tag
	 * produced it — several collapse onto one — so a reader chasing a disagreement needs this to know what was actually
	 * asserted.
	 */
	tag?: string
}

/**
 * How the two readings related on ONE label. `agree` and `value-differs` both mean both parsers produced the label; the
 * `*-only` pair means one did not, which is a different kind of disagreement and never blended with the other.
 */
export const SpanVerdict = {
	Agree: "agree",
	ValueDiffers: "value-differs",
	MailwomanOnly: "mailwoman-only",
	LibpostalOnly: "libpostal-only",
} as const

export type SpanVerdict = (typeof SpanVerdict)[keyof typeof SpanVerdict]

export interface SpanDiff {
	label: string
	verdict: SpanVerdict
	mailwoman: string | null
	libpostal: string | null
	/**
	 * Set when several mailwoman tags map onto this one label, so a reader does not take the agreement at face value.
	 */
	collapsed_from?: string[]
}

export interface ParseComparisonRow {
	id: string
	input: string
	mailwoman: LabelledSpan[]
	libpostal: LabelledSpan[] | null
	/**
	 * Why libpostal produced nothing, when it produced nothing. A transport failure and a parser that found no components
	 * are different facts and reach a reader as the same empty list otherwise.
	 */
	libpostal_error: string | null
	diff: SpanDiff[]
	agrees: boolean
}

/**
 * Which mailwoman tags share each libpostal label — the collapse, read off the shared map rather than restated.
 */
const TAGS_PER_LABEL: ReadonlyMap<string, string[]> = buildTagsPerLabel()

function buildTagsPerLabel(): ReadonlyMap<string, string[]> {
	const tally = new Map<string, string[]>()

	for (const [tag, label] of Object.entries(COMPONENT_TO_LIBPOSTAL)) {
		tally.set(label, [...(tally.get(label) ?? []), tag])
	}

	return tally
}

/**
 * Mailwoman's reading, in libpostal's vocabulary, with each span's originating tag retained.
 */
export function mailwomanSpans(tree: AddressTree): LabelledSpan[] {
	const matches = treeToParseMatches(tree)
	const mapped = toLibpostalComponents(matches)

	// Positional pairing: `toLibpostalComponents` is a `map`, so index i of its output is index i of its input. Reading
	// the tag back by matching values would mispair a row carrying the same value under two tags.
	return mapped.map((component, index) => ({
		label: component.label,
		value: component.value,
		...(matches[index] ? { tag: matches[index]!.classification } : {}),
	}))
}

/**
 * One libpostal endpoint, paced and mapped the way every other HTTP caller in this repo is.
 */
export function libpostalClient(endpoint: string): APIClient {
	return new APIClient({
		displayName: "libpostal-parse",
		minRequestIntervalMs: EXTERNAL_ARM_MIN_REQUEST_INTERVAL_MS,
		axios: {
			baseURL: assertScorableEndpoint(endpoint),
			timeout: PARSE_TIMEOUT_MS,
			headers: { "User-Agent": "mailwoman-dev-mcp" },
		},
	})
}

/**
 * Ask an endpoint for its reading.
 *
 * `address` rather than `query`: it is the parameter the reference libpostal REST server takes, and `@mailwoman/
 * libpostal` accepts it as an alias, so one spelling reaches both.
 */
export async function libpostalSpans(client: APIClient, input: string): Promise<LabelledSpan[]> {
	const response = await client.fetch<unknown>({ url: `/parse?address=${encodeURIComponent(input)}` })
	const body = response.data

	if (!Array.isArray(body)) {
		throw new TypeError(`/parse did not answer with an array; got ${JSON.stringify(body).slice(0, 120)}`)
	}

	return body
		.filter((entry): entry is { label: string; value: string } => isLabelledSpan(entry))
		.map((entry) => ({ label: entry.label, value: entry.value }))
}

function isLabelledSpan(entry: unknown): boolean {
	return (
		typeof entry === "object" &&
		entry !== null &&
		typeof (entry as { label?: unknown }).label === "string" &&
		typeof (entry as { value?: unknown }).value === "string"
	)
}

/**
 * Diff two readings by label.
 *
 * Spans sharing a label are joined in reading order before comparison, because libpostal emits one span per label per
 * occurrence and mailwoman's collapse can emit a different number for the same reading. Comparing occurrence-by-
 * occurrence would report a disagreement caused by segmentation rather than by either parser's answer.
 */
export function diffSpans(mailwoman: readonly LabelledSpan[], libpostal: readonly LabelledSpan[]): SpanDiff[] {
	const labels = [...new Set([...mailwoman.map((s) => s.label), ...libpostal.map((s) => s.label)])].toSorted()

	return labels.map((label): SpanDiff => {
		const ours = join(mailwoman, label)
		const theirs = join(libpostal, label)
		const collapsedFrom = TAGS_PER_LABEL.get(label) ?? []

		const verdict: SpanVerdict =
			ours === null
				? SpanVerdict.LibpostalOnly
				: theirs === null
					? SpanVerdict.MailwomanOnly
					: fold(ours) === fold(theirs)
						? SpanVerdict.Agree
						: SpanVerdict.ValueDiffers

		return {
			label,
			verdict,
			mailwoman: ours,
			libpostal: theirs,
			...(collapsedFrom.length > 1 ? { collapsed_from: collapsedFrom } : {}),
		}
	})
}

function join(spans: readonly LabelledSpan[], label: string): string | null {
	const values = spans.filter((span) => span.label === label).map((span) => span.value)

	return values.length ? values.join(" ") : null
}

function fold(value: string): string {
	return value.toLowerCase().replaceAll(/\s+/gu, " ").trim()
}
