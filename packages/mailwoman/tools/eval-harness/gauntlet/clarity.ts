// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Renders one board row at several levels of clarity, from its full address down to
 *   a bare name, and grades each rendering against the row's truth point.
 *
 *   The axes follow the `wof-admin` training adapter: how much context a place is
 *   written with, and which form each level is written in.
 *   A rendering keeps or drops the spans of a row's asserted components, so a row whose
 *   value is absent from its input cannot render that level and reports why.
 */

import { countrySurfaceForms } from "@mailwoman/codex/country/country"
import { hashFNV1a } from "@mailwoman/core/coarse-placer/fnv-hash"
import { regionCodeFor, regionNameFor } from "@mailwoman/corpus/adapters/wof/admin/json/region-codes"
import { haversine } from "@mailwoman/spatial/geometries/point/distance"

import { achievedRung, type AblationLadder } from "#ablation/expectation"
import { boundedOccurrences, deleteSpan } from "#tools/eval-harness/gauntlet/ablation"

/**
 * A component's span in a row's input.
 */
export interface ComponentSpan {
	tag: string
	start: number
	end: number
}

/**
 * The tags an address writes after the street.
 *
 * A repeated value of one of these tags is read at its last occurrence.
 *
 * `Accident Library, 106 S North St, Accident, MD 21520` writes its locality last.
 */
const TRAILING_TAGS: ReadonlySet<string> = new Set(["dependent_locality", "locality", "region", "postcode", "country"])

/**
 * Locates each asserted component in the input, longest value first, so a shorter value
 * cannot claim a place inside a longer one: `Accident` stays out of `Accident Library`.
 */
export function locateComponents(input: string, components: Readonly<Record<string, string>>): ComponentSpan[] {
	const spans: ComponentSpan[] = []

	const ordered = Object.entries(components)
		.map(([tag, value]) => ({ tag, value: value.trim() }))
		.filter(({ value }) => value)
		.toSorted((a, b) => b.value.length - a.value.length)

	for (const { tag, value } of ordered) {
		const free = boundedOccurrences(input, value).filter((start) =>
			spans.every((span) => start + value.length <= span.start || span.end <= start)
		)

		const start = TRAILING_TAGS.has(tag) ? free.at(-1) : free[0]

		if (typeof start === "number") {
			spans.push({ tag, start, end: start + value.length })
		}
	}

	return spans.toSorted((a, b) => a.start - b.start)
}

/**
 * Joins kept spans with the separator their input wrote between them.
 */
function renderKept(input: string, spans: readonly ComponentSpan[]): string {
	return spans
		.map((span, index) => {
			const between = index ? input.slice(spans[index - 1]!.end, span.start) : ""
			const separator = !index || !between ? "" : between.includes(",") ? ", " : " "

			return separator + input.slice(span.start, span.end)
		})
		.join("")
}

/**
 * Deletes spans from the input, last first, so an earlier span's offsets stay true.
 */
function renderDropped(input: string, spans: readonly ComponentSpan[]): string {
	let text = input

	for (const span of spans.toReversed()) {
		text = deleteSpan(text, span.start, span.end - span.start)
	}

	return text
}

/**
 * One level of clarity.
 *
 * A level keeps listed tags or drops them.
 * `requires` lists the tags a row must hold for the level to render,
 * so a row with no venue renders no `venue_only`.
 */
interface ClarityLevel {
	id: string
	keep?: readonly string[]
	drop?: readonly string[]
	requires: readonly string[]
}

/**
 * The levels of clarity below the full address, clearest first.
 */
export const CLARITY_LEVELS: readonly ClarityLevel[] = [
	{ id: "no_postcode", drop: ["postcode"], requires: ["postcode"] },
	{ id: "no_country", drop: ["country"], requires: ["country"] },
	{ id: "no_venue", drop: ["venue"], requires: ["venue"] },
	{ id: "venue_locality_region", keep: ["venue", "locality", "region"], requires: ["venue", "locality", "region"] },
	{ id: "venue_locality", keep: ["venue", "locality"], requires: ["venue", "locality"] },
	{ id: "venue_region", keep: ["venue", "region"], requires: ["venue", "region"] },
	{ id: "venue_country", keep: ["venue", "country"], requires: ["venue", "country"] },
	{ id: "venue_only", keep: ["venue"], requires: ["venue"] },
	{ id: "locality_region", keep: ["locality", "region"], requires: ["locality", "region"] },
	{ id: "locality_only", keep: ["locality"], requires: ["locality"] },
]

/**
 * Tags whose survival anchors a rendering to a place, so its answer has to lie on the row's admin chain.
 */
const ANCHORING_TAGS: ReadonlySet<string> = new Set(["locality", "dependent_locality", "region", "postcode"])

/**
 * One rendering of a row.
 */
export interface ClarityVariant {
	level: string
	input: string
	/**
	 * Whether a surviving component anchors the rendering to a place.
	 *
	 * An unanchored rendering is a bare name, and more than one place can hold it.
	 */
	anchored: boolean
}

/**
 * The other written form of a row's region or country, chosen by a hash of the row's id.
 */
function alternateForm(tag: string, value: string, country: string, rowID: string): string | null {
	if (tag === "region") {
		return regionNameFor(country, value) ?? regionCodeFor(country, value)
	}

	if (tag === "country") {
		const forms = countrySurfaceForms(country).filter((form) => form.toLowerCase() !== value.toLowerCase())

		return forms.length ? forms[hashFNV1a(rowID) % forms.length]! : null
	}

	return null
}

/**
 * Renders every level of clarity a row's components support, deduplicated, leaving out the row's own input.
 */
export function clarityVariants(row: {
	id: string
	input: string
	country: string
	components: Readonly<Record<string, string>>
}): ClarityVariant[] {
	const spans = locateComponents(row.input, row.components)
	const located = new Set(spans.map((span) => span.tag))
	const seen = new Set([row.input])
	const variants: ClarityVariant[] = []

	const add = (level: string, input: string, anchored: boolean) => {
		if (input && !seen.has(input)) {
			seen.add(input)
			variants.push({ level, input, anchored })
		}
	}

	for (const level of CLARITY_LEVELS) {
		if (!level.requires.every((tag) => located.has(tag))) continue

		const kept = level.keep
			? spans.filter((span) => level.keep!.includes(span.tag))
			: spans.filter((span) => !level.drop!.includes(span.tag))

		const input = level.keep
			? renderKept(row.input, kept)
			: renderDropped(
					row.input,
					spans.filter((span) => level.drop!.includes(span.tag))
				)

		add(
			level.id,
			input,
			kept.some((span) => ANCHORING_TAGS.has(span.tag))
		)
	}

	for (const span of spans) {
		const form = alternateForm(span.tag, row.input.slice(span.start, span.end), row.country, row.id)

		if (form) {
			add(`${span.tag}_form`, row.input.slice(0, span.start) + form + row.input.slice(span.end), true)
		}
	}

	return variants
}

/**
 * How one rendering's answer stands against the row's truth.
 *
 * - `exact`: inside the row's tolerance.
 * - `on_chain`: outside the tolerance, inside a place on the row's admin chain.
 * - `declared`: marked ambiguous, with the truth among the alternatives.
 * - `abstained`: no coordinate.
 * - `wrong_place`: anywhere else.
 */
export type ClarityOutcome = "exact" | "on_chain" | "declared" | "abstained" | "wrong_place"

/**
 * The fields of a geocode answer this layer reads.
 */
export interface ClarityAnswer {
	lat: number | null
	lon: number | null
	declaredAmbiguity: boolean
	candidates: ReadonlyArray<{ lat: number; lon: number }>
}

/**
 * Grades one answer, and states whether the rendering's evidence permits it.
 *
 * An anchored rendering expects an answer on the row's chain, because its
 * surviving components locate the place.
 * A bare name also accepts an abstention and a declared ambiguity, and never a silent answer elsewhere.
 */
export function gradeClarityAnswer(input: {
	answer: ClarityAnswer
	truth: { lat: number; lon: number; toleranceKm: number }
	ladder: AblationLadder | null
	anchored: boolean
}): { outcome: ClarityOutcome; km: number | null; met: boolean } {
	const { answer, truth, ladder, anchored } = input
	const nearTruth = (lat: number, lon: number) => haversine(truth.lat, truth.lon, lat, lon) <= truth.toleranceKm
	const resolved = answer.lat != null && answer.lon != null
	const km = resolved ? haversine(truth.lat, truth.lon, answer.lat!, answer.lon!) : null

	const outcome: ClarityOutcome = !resolved
		? "abstained"
		: nearTruth(answer.lat!, answer.lon!)
			? "exact"
			: ladder && achievedRung(answer.lat!, answer.lon!, ladder)
				? "on_chain"
				: answer.declaredAmbiguity && answer.candidates.some((c) => nearTruth(c.lat, c.lon))
					? "declared"
					: "wrong_place"

	const met = outcome === "exact" || outcome === "on_chain" || (!anchored && outcome !== "wrong_place")

	return { outcome, km, met }
}

/**
 * The counts of one level or kind.
 */
export type ClarityCounts = Record<ClarityOutcome, number> & { n: number; met: number }

/**
 * An empty count.
 */
export function emptyClarityCounts(): ClarityCounts {
	return { exact: 0, on_chain: 0, declared: 0, abstained: 0, wrong_place: 0, n: 0, met: 0 }
}

/**
 * The sparsest level at which a row's place still answered inside tolerance,
 * in {@link CLARITY_LEVELS} order.
 *
 * `null` means no rendering did, including the full address.
 */
export function holdsDownTo(rows: ReadonlyArray<{ level: string; outcome: ClarityOutcome }>): string | null {
	const order = ["full", ...CLARITY_LEVELS.map((level) => level.id)]

	return (
		rows
			.filter((row) => row.outcome === "exact" && order.includes(row.level))
			.toSorted((a, b) => order.indexOf(b.level) - order.indexOf(a.level))[0]?.level ?? null
	)
}
