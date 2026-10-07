/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Diff two geocodes of the same input — the parse diff plus what the resolver did with it.
 *
 *   A distance delta by itself shows that the answer moved and leaves the cause open. The three ways a geocode changes are
 *   different problems with different fixes: the parse changed (a different question was asked), a
 *   span resolved to a different place (ranking or gazetteer coverage), or the tier changed (a lookup
 *   missed and the same components fell through to a coarser rung).
 *
 *   It lives in `mailwoman` rather than beside the parse diff in `core` because it needs
 *   `haversineKm`. `@mailwoman/spatial` depends on `@mailwoman/core`, so putting this module in core would
 *   close a cycle.
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
	placeID: string | null
	lat: number | null
	lon: number | null
	/**
	 * How many candidates the retrieval considered.
	 *
	 * Breadth rather than correctness.
	 * A span that won from 40 is less settled than one that won from 2, even when both picked the same place.
	 */
	candidates: number | null
}

/**
 * What changed for one span's resolution, independent of whether its parse changed.
 */
export interface SpanGeoDelta {
	tag: string
	value: string
	placeIDBefore: string | null
	placeIDAfter: string | null
	/**
	 * Kilometers between the two arms' centroids for this span, when both resolved.
	 */
	movedKm: number | null
	candidatesBefore: number | null
	candidatesAfter: number | null
	/**
	 * `resolved` / `unresolved` / `repointed` — the last meaning the span kept its text
	 * and tag and landed on a different place.
	 */
	kind: "repointed" | "resolved" | "unresolved" | "unchanged"
}

export interface GeocodeDiff {
	input: string
	/**
	 * The span-level parse story.
	 *
	 * When `parse.identical` is false the resolver was asked a different question and is not the suspect.
	 */
	parse: ParseDiff
	spanGeo: SpanGeoDelta[]
	tierBefore: string | null
	tierAfter: string | null
	latBefore: number | null
	lonBefore: number | null
	latAfter: number | null
	lonAfter: number | null
	/**
	 * Kilometers the final answer moved.
	 *
	 * Null when either arm returned no coordinate.
	 * This differs from a zero-kilometer move and must not be read as one.
	 */
	movedKm: number | null
	uncertaintyBefore: number | null
	uncertaintyAfter: number | null
	identical: boolean
	/**
	 * Which of the three explanations the evidence supports.
	 *
	 * Stated rather than left to the reader, since a distance delta by itself cannot choose between them.
	 */
	attribution:
		| "parse-changed"
		| "retrieval-repointed"
		| "tier-changed"
		| "unchanged"
		| "coordinate-appeared-or-vanished"
}

function resolutions(tree: AddressTree | null): Map<string, SpanResolution> {
	const out = new Map<string, SpanResolution>()

	for (const node of flattenTreeNodes(tree)) {
		out.set(`${node.start}:${node.end}:${node.tag}`, {
			tag: node.tag,
			value: node.value,
			placeID: node.placeID ?? null,
			lat: node.lat ?? null,
			lon: node.lon ?? null,
			candidates: node.alternatives ?? null,
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
 * Diff two geocodes of the same input.
 *
 * Report which of the three explanations the evidence supports.
 */
export function diffGeocode(input: string, before: GeocodeArm, after: GeocodeArm): GeocodeDiff {
	const parse = diffParse(input, before.tree ?? null, after.tree ?? null, {
		...(before.localeCountry ? { before: before.localeCountry } : {}),
		...(after.localeCountry ? { after: after.localeCountry } : {}),
	})

	const ra = resolutions(before.tree ?? null)
	const rb = resolutions(after.tree ?? null)
	const spanGeo: SpanGeoDelta[] = []

	for (const [key, left] of ra) {
		const right = rb.get(key)

		if (!right) continue

		const bothPlaced = left.lat !== null && left.lon !== null && right.lat !== null && right.lon !== null

		const movedKm = bothPlaced ? haversineKm(left.lat!, left.lon!, right.lat!, right.lon!) : null
		const repointed = left.placeID !== right.placeID

		const kind: SpanGeoDelta["kind"] = repointed
			? "repointed"
			: left.placeID === null && right.placeID !== null
				? "resolved"
				: left.placeID !== null && right.placeID === null
					? "unresolved"
					: "unchanged"

		spanGeo.push({
			tag: left.tag,
			value: left.value,
			placeIDBefore: left.placeID,
			placeIDAfter: right.placeID,
			movedKm,
			candidatesBefore: left.candidates,
			candidatesAfter: right.candidates,
			kind,
		})
	}

	const bothPlaced = before.lat !== null && before.lat !== undefined && after.lat !== null && after.lat !== undefined
	const movedKm = bothPlaced ? haversineKm(before.lat!, before.lon!, after.lat!, after.lon!) : null
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
		tierBefore: before.tier ?? null,
		tierAfter: after.tier ?? null,
		latBefore: before.lat ?? null,
		lonBefore: before.lon ?? null,
		latAfter: after.lat ?? null,
		lonAfter: after.lon ?? null,
		movedKm,
		uncertaintyBefore: before.uncertaintyM ?? null,
		uncertaintyAfter: after.uncertaintyM ?? null,
		identical: attribution === "unchanged" && (movedKm ?? 0) === 0,
		attribution,
	}
}

/**
 * Meters below which a coordinate move is rendered as "same point".
 *
 * Int8 quantization and float round-tripping move a centroid by centimeters.
 * A delta rendering buries the moves that matter.
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

	if (diff.movedKm !== null && diff.movedKm * 1000 >= SAME_POINT_M) {
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
			span.movedKm === null
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

	// The parse story last, because when attribution is `parse-changed` it is the explanation and the reader needs it.
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
