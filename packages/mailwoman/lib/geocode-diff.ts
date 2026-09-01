/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Diff two GEOCODES of the same input — the parse diff plus what the resolver did with it.
 *
 *   A distance delta on its own is the geocoding equivalent of a component map: it says the answer moved and not why.
 *   The three ways a geocode changes are different problems with different fixes, and only a per-span view separates
 *   them:
 *
 *   1. **The parse changed**, so the resolver was asked a different question. Nothing is wrong with retrieval.
 *   2. **The parse held and a span resolved to a different PLACE** — same text, same tag, new `placeID`. That is a
 *      ranking or a gazetteer-coverage problem.
 *   3. **The parse held, the places held, and the TIER changed** — the same components fell through to a coarser rung
 *      because a rooftop or interpolation lookup missed. That is a data-coverage problem and no amount of model work
 *      touches it.
 *
 *   It lives in `mailwoman` rather than beside the parse diff in `core` because it needs `haversineKm`, and
 *   `@mailwoman/spatial` depends on `@mailwoman/core` — putting it in core would close a cycle. Re-implementing the
 *   haversine to avoid the move is the other wrong answer; `AGENTS.md` names spatial as its one home.
 *
 *   The retrieval BREADTH per span is carried for the same reason a per-span confidence is: a span that resolved to the
 *   same place from 40 candidates instead of 2 is one gazetteer edit away from moving, and an answer that did not
 *   change yet is not the same as an answer that is stable.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import { flattenTreeNodes } from "@mailwoman/core/decoder"
import { diffParse, isChange, type ParseDiff, type SpanDelta } from "@mailwoman/core/decoder/parse-diff"
import { haversineKm } from "@mailwoman/spatial"

/**
 * The resolver's answer for one span, on one arm.
 */
export interface SpanResolution {
	tag: string
	value: string
	placeID?: string
	lat?: number
	lon?: number
	/**
	 * How many candidates the retrieval considered. Breadth, not correctness — a span that won from 40 is less settled
	 * than one that won from 2, even when both picked the same place.
	 */
	candidates?: number
}

/**
 * What changed for one span's RESOLUTION, independent of whether its parse changed.
 */
export interface SpanGeoDelta {
	tag: string
	value: string
	placeIDBefore?: string
	placeIDAfter?: string
	/**
	 * Kilometres between the two arms' centroids for this span, when both resolved.
	 */
	movedKm?: number
	candidatesBefore?: number
	candidatesAfter?: number
	/**
	 * `resolved` / `unresolved` / `repointed` — the last meaning the span kept its text and tag and landed on a different
	 * place.
	 */
	kind: "repointed" | "resolved" | "unresolved" | "unchanged"
}

export interface GeocodeDiff {
	input: string
	/**
	 * The span-level parse story. A geocode change whose `parse.identical` is false was asked a different question, and
	 * the resolver is not the suspect.
	 */
	parse: ParseDiff
	spanGeo: SpanGeoDelta[]
	tierBefore?: string
	tierAfter?: string
	latBefore?: number | null
	lonBefore?: number | null
	latAfter?: number | null
	lonAfter?: number | null
	/**
	 * Kilometres the FINAL answer moved. Undefined when either arm returned no coordinate — which is a different event
	 * from moving zero kilometres and must not read as one.
	 */
	movedKm?: number
	uncertaintyBefore?: number | null
	uncertaintyAfter?: number | null
	identical: boolean
	/**
	 * Which of the three explanations the evidence supports. Stated rather than left to the reader, because the whole
	 * point is that a distance delta alone cannot choose between them.
	 */
	attribution:
		| "parse-changed"
		| "retrieval-repointed"
		| "tier-changed"
		| "unchanged"
		| "coordinate-appeared-or-vanished"
}

function resolutions(tree: AddressTree | null | undefined): Map<string, SpanResolution> {
	const out = new Map<string, SpanResolution>()

	for (const node of flattenTreeNodes(tree)) {
		out.set(`${node.start}:${node.end}:${String(node.tag)}`, {
			tag: String(node.tag),
			value: node.value,
			...(node.placeID === undefined ? {} : { placeID: node.placeID }),
			...(node.lat === undefined ? {} : { lat: node.lat }),
			...(node.lon === undefined ? {} : { lon: node.lon }),
			...(node.alternatives === undefined ? {} : { candidates: node.alternatives }),
		})
	}

	return out
}

export interface GeocodeArm {
	tree?: AddressTree | null
	lat?: number | null
	lon?: number | null
	tier?: string
	uncertaintyM?: number | null
	localeCountry?: { country: string; confidence: number }
}

/**
 * Diff two geocodes of the same input, and say which of the three explanations the evidence supports.
 */
export function diffGeocode(input: string, before: GeocodeArm, after: GeocodeArm): GeocodeDiff {
	const parse = diffParse(input, before.tree, after.tree, {
		...(before.localeCountry ? { before: before.localeCountry } : {}),
		...(after.localeCountry ? { after: after.localeCountry } : {}),
	})

	const ra = resolutions(before.tree)
	const rb = resolutions(after.tree)
	const spanGeo: SpanGeoDelta[] = []

	for (const [key, left] of ra) {
		const right = rb.get(key)

		if (!right) continue

		const bothPlaced =
			left.lat !== undefined && left.lon !== undefined && right.lat !== undefined && right.lon !== undefined

		const movedKm = bothPlaced ? haversineKm(left.lat!, left.lon!, right.lat!, right.lon!) : undefined
		const repointed = left.placeID !== right.placeID

		const kind: SpanGeoDelta["kind"] = repointed
			? "repointed"
			: left.placeID === undefined && right.placeID !== undefined
				? "resolved"
				: left.placeID !== undefined && right.placeID === undefined
					? "unresolved"
					: "unchanged"

		spanGeo.push({
			tag: left.tag,
			value: left.value,
			...(left.placeID === undefined ? {} : { placeIDBefore: left.placeID }),
			...(right.placeID === undefined ? {} : { placeIDAfter: right.placeID }),
			...(movedKm === undefined ? {} : { movedKm }),
			...(left.candidates === undefined ? {} : { candidatesBefore: left.candidates }),
			...(right.candidates === undefined ? {} : { candidatesAfter: right.candidates }),
			kind,
		})
	}

	const bothPlaced = before.lat !== null && before.lat !== undefined && after.lat !== null && after.lat !== undefined
	const movedKm = bothPlaced ? haversineKm(before.lat!, before.lon!, after.lat!, after.lon!) : undefined
	const tierChanged = before.tier !== after.tier
	const anyRepoint = spanGeo.some((s) => s.kind !== "unchanged")

	const placedChanged =
		(before.lat === null || before.lat === undefined) !== (after.lat === null || after.lat === undefined)

	const attribution: GeocodeDiff["attribution"] = placedChanged
		? "coordinate-appeared-or-vanished"
		: !parse.identical
			? "parse-changed"
			: anyRepoint
				? "retrieval-repointed"
				: tierChanged
					? "tier-changed"
					: "unchanged"

	return {
		input,
		parse,
		spanGeo,
		...(before.tier === undefined ? {} : { tierBefore: before.tier }),
		...(after.tier === undefined ? {} : { tierAfter: after.tier }),
		latBefore: before.lat ?? null,
		lonBefore: before.lon ?? null,
		latAfter: after.lat ?? null,
		lonAfter: after.lon ?? null,
		...(movedKm === undefined ? {} : { movedKm }),
		uncertaintyBefore: before.uncertaintyM ?? null,
		uncertaintyAfter: after.uncertaintyM ?? null,
		identical: attribution === "unchanged" && (movedKm ?? 0) === 0,
		attribution,
	}
}

/**
 * Metres below which a coordinate move is rendered as "same point".
 *
 * Int8 quantization and float round-tripping move a centroid by centimetres; rendering that as a delta buries the moves
 * that matter.
 */
export const SAME_POINT_M = 1

/**
 * Render a geocode diff address-first, with the attribution stated before the numbers.
 */
export function renderGeocodeDiff(diff: GeocodeDiff): string {
	const lines: string[] = [diff.input, `  attribution: ${diff.attribution}`]

	if (diff.tierBefore !== diff.tierAfter) {
		lines.push(`  ! tier ${diff.tierBefore ?? "—"} → ${diff.tierAfter ?? "—"}`)
	}

	if (diff.movedKm !== undefined && diff.movedKm * 1000 >= SAME_POINT_M) {
		lines.push(
			`  ! answer moved ${diff.movedKm < 1 ? `${(diff.movedKm * 1000).toFixed(0)} m` : `${diff.movedKm.toFixed(2)} km`}`
		)
	} else if (diff.latBefore === null && diff.latAfter !== null) {
		lines.push(`  + answer gained a coordinate (${diff.latAfter}, ${diff.lonAfter})`)
	} else if (diff.latBefore !== null && diff.latAfter === null) {
		lines.push(`  - answer LOST its coordinate`)
	}

	for (const span of diff.spanGeo) {
		if (span.kind === "unchanged" && (span.candidatesBefore ?? 0) === (span.candidatesAfter ?? 0)) continue

		const moved =
			span.movedKm === undefined
				? ""
				: `  ${span.movedKm < 1 ? `${(span.movedKm * 1000).toFixed(0)} m` : `${span.movedKm.toFixed(1)} km`}`

		const breadth =
			span.candidatesBefore === span.candidatesAfter
				? ""
				: `  candidates ${span.candidatesBefore ?? "—"} → ${span.candidatesAfter ?? "—"}`

		lines.push(`  ${span.kind === "unchanged" ? "~" : "!"} ${span.tag}="${span.value}" ${span.kind}${moved}${breadth}`)

		if (span.placeIDBefore !== span.placeIDAfter) {
			lines.push(`      place ${span.placeIDBefore ?? "—"} → ${span.placeIDAfter ?? "—"}`)
		}
	}

	// The parse story last, because when attribution is `parse-changed` it IS the explanation and the reader needs it.
	if (!diff.parse.identical) {
		for (const span of diff.parse.spans.filter(isChange)) {
			lines.push(`  · parse: ${describeSpan(span)}`)
		}
	}

	return lines.join("\n")
}

function describeSpan(span: SpanDelta): string {
	if (span.kind === "retagged") return `${span.tagBefore} → ${span.tagAfter} "${span.valueAfter}"`

	if (span.kind === "moved") return `${span.tagAfter} moved "${span.valueBefore}" → "${span.valueAfter}"`

	if (span.kind === "removed") return `removed ${span.tagBefore}="${span.valueBefore}"`

	if (span.kind === "added") return `added ${span.tagAfter}="${span.valueAfter}"`

	return `${span.tagAfter}="${span.valueAfter}" confidence ${(span.confidenceDelta ?? 0) >= 0 ? "+" : ""}${(span.confidenceDelta ?? 0).toFixed(2)}`
}
