/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   What is this string made OF — mailwoman's reading against libpostal's, on the same input.
 *
 *   `mwdev_compare` grades geocoders on a coordinate, and libpostal produces none, so this gets its own surface rather
 *   than a column in a distance table: it is the only genuinely like-for-like parse comparison available, being Pelias's
 *   parser with `@mailwoman/libpostal` implementing its exact `/parse` interface.
 *
 *   Both sides are expressed in libpostal's label vocabulary using the drop-in's own converter,
 *   `treeToParseMatches` + `toLibpostalComponents`, and that map is many-to-one — `neighbourhood` and
 *   `dependent_locality` both become `suburb` — so label agreement is not tag agreement and the mailwoman side carries
 *   its original tag.
 *
 *   Values are compared case-folded because libpostal lowercases its output and mailwoman preserves the input's case.
 *
 *   No winner is declared: two parsers disagreeing says where to look, and grading libpostal against mailwoman's tag
 *   vocabulary would run the lossy map in the direction that loses.
 */

import { APIClient } from "@mailwoman/core/api"
import type { AddressTree } from "@mailwoman/core/decoder"
import { stringifyJSON } from "@mailwoman/core/json"
import { COMPONENT_TO_LIBPOSTAL, toLibpostalComponents, treeToParseMatches } from "@mailwoman/libpostal"
import { foldCaseWhitespace } from "@mailwoman/normalize/fold"

import { assertScorableEndpoint, EXTERNAL_ARM_MIN_REQUEST_INTERVAL_MS } from "#external-arm"

const PARSE_TIMEOUT_MS = 15_000

export interface LabelledSpan {
	label: string
	value: string
	/**
	 * Mailwoman's own `ComponentTag` before the mapping; the label alone cannot say
	 * which tag produced it, since several collapse onto one.
	 */
	tag?: string
}

/**
 * `agree` and `value-differs` both mean both parsers produced the label; the `*-only` pair
 * means one did not, a different kind of disagreement that is never blended with the other.
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
	 * Set when several mailwoman tags map onto this one label, so a reader does
	 * not take the agreement at face value.
	 */
	collapsed_from?: string[]
}

export interface ParseComparisonRow {
	id: string
	input: string
	mailwoman: LabelledSpan[]
	libpostal: LabelledSpan[] | null
	/**
	 * A transport failure and a parser that found no components are different facts
	 * that otherwise reach a reader as the same empty list.
	 */
	libpostal_error: string | null
	diff: SpanDiff[]
	agrees: boolean
}

/**
 * The collapse, read off the shared map rather than restated.
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

	// Positional pairing: `toLibpostalComponents` is a `map`, so index i of its
	// output is index i of its input; reading the tag back by matching values would
	// mispair a row carrying the same value under two tags.
	return mapped.map((component, index) => ({
		label: component.label,
		value: component.value,
		...(matches[index] ? { tag: matches[index]!.classification } : {}),
	}))
}

/**
 * Paced and mapped the way every other http caller in this repo is.
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
 * `address` rather than `query` is the parameter the reference libpostal rest server takes,
 * and `@mailwoman/libpostal` accepts it as an alias, so one spelling reaches both.
 */
export async function libpostalSpans(client: APIClient, input: string): Promise<LabelledSpan[]> {
	const response = await client.fetch<unknown>({ url: `/parse?address=${encodeURIComponent(input)}` })
	const body = response.data

	if (!Array.isArray(body)) {
		throw new TypeError(`/parse did not answer with an array; got ${stringifyJSON(body).slice(0, 120)}`)
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
 * Spans sharing a label are joined in reading order before comparison, because libpostal
 * emits one span per label per occurrence while mailwoman's collapse can emit a different
 * number for the same reading — so comparing occurrence-by- occurrence would report a
 * disagreement caused by segmentation rather than by either parser's answer.
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
					: foldCaseWhitespace(ours) === foldCaseWhitespace(theirs)
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
