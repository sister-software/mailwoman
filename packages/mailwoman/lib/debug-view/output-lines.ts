/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `--debug` output pane's contents as an ordered, flat list of lines — the terminal's answer to the docs demo's
 *   result panel, section for section: parsed components, the kind verdict, stage timing, the resolved place, the admin
 *   hierarchy, then the runner-up candidates.
 *
 *   FLAT is the design, not a shortcut. The pane scrolls, and a scroll offset over a nested structure has to be
 *   translated into "which section, which row" by whoever draws it AND by whoever clamps the offset; over a flat list
 *   both are `slice`. That is also why this module is pure data rather than elements: `DebugFrame` renders the list and
 *   `DebugSessionApp` clamps its ↑/↓ against the SAME list, so the two can't disagree about how far down it goes.
 *
 *   Nothing here computes an address fact. Every value is read off the {@link GeocodeResult}, the {@link AddressTree},
 *   or the session's own clock; a section with no data is OMITTED rather than rendered empty, and a field with no value
 *   renders {@link ABSENT}.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"

import { ABSENT } from "#debug-view/trace-rows"
import type { GeocodeResult } from "#geocode-result"
import type { GeocodeTrace } from "#geocode-session"

//#region Contract

/**
 * One rendered row of the output pane.
 *
 * `tag` and `confidence` are the two fields that carry presentation weight: a `tag` colors the label from the shared
 * component palette (the same one the span ribbon uses, so a row and its ribbon chip are the same color), and a
 * `confidence` draws the demo's confidence chip. Both are optional because most rows are neither.
 */
export interface OutputLine {
	/**
	 * `heading` opens a section; `error` is a failed re-run's message; `field` is everything else.
	 */
	kind: "heading" | "field" | "error"
	label: string
	value?: string
	/**
	 * Dim trailing text — an id, a coordinate, a unit.
	 */
	detail?: string
	/**
	 * Component tag coloring the label, when the row is about one.
	 */
	tag?: string
	/**
	 * 0..1, drawn as the confidence chip.
	 */
	confidence?: number
	/**
	 * Rendered as a badge INSTEAD of `value` — reserved for the two verdicts a reader scans for first, the resolution
	 * tier and the kind. A badge on every row would be a badge on none.
	 */
	badge?: string
	/**
	 * Badge background. Carried here rather than derived at render time because the meaning is the data's: an `admin`
	 * tier is a weaker answer than a rooftop, and only this module knows that.
	 */
	badgeColor?: string
}

//#endregion

//#region Formatting helpers

/**
 * Six decimals ≈ 0.1 m — finer than any tier's uncertainty, and short enough to read. Trimmed of trailing zeros
 * (`Number(…)`) so a gazetteer centroid stored at four decimals still prints as four.
 */
function formatCoordinate(lat: number | null | undefined, lon: number | null | undefined): string {
	if (lat == null || lon == null) return "unresolved"

	return `${Number(lat.toFixed(6))}, ${Number(lon.toFixed(6))}`
}

/**
 * Milliseconds at one decimal — enough to tell a 3 ms decode from a 40 ms resolve without implying we measured
 * microseconds.
 */
function formatMsFixed(ms: number): string {
	return `${ms.toFixed(1)} ms`
}

/**
 * Depth-first, parents before children, in span order — the order the address reads. Children are indented so a
 * street's prefix/suffix stay visibly subordinate to it rather than looking like siblings of the locality.
 */
function componentLines(tree: AddressTree): OutputLine[] {
	const lines: OutputLine[] = []

	const visit = (node: AddressNode, depth: number): void => {
		lines.push({
			kind: "field",
			label: `${"  ".repeat(depth)}${node.tag}`,
			tag: node.tag,
			value: node.value,
			confidence: node.confidence,
		})

		for (const child of node.children) {
			visit(child, depth + 1)
		}
	}

	for (const root of tree.roots) {
		visit(root, 0)
	}

	return lines
}

//#endregion

//#region Builder

export interface OutputLinesInput {
	result: GeocodeResult
	tree: AddressTree
	/**
	 * Only `kind` is read; `Pick` says so, and lets a test hand in exactly that.
	 */
	trace?: Pick<GeocodeTrace, "kind">
	/**
	 * Per-phase wall clock from the session ({@link GeocodeRun.timing}). Absent on a caller that didn't measure — the
	 * timing section is then omitted rather than showing zeros.
	 */
	timing?: Record<string, number>
	/**
	 * A failed re-run's message. Rendered first, red, above a result that is deliberately still the previous one.
	 */
	errorNote?: string | null
}

/**
 * Build the pane's whole line list, in the demo's section order.
 */
export function outputLines(input: OutputLinesInput): OutputLine[] {
	const { result, tree, trace, timing, errorNote } = input
	const lines: OutputLine[] = []

	if (errorNote) {
		lines.push({ kind: "error", label: errorNote })
	}

	const components = componentLines(tree)

	if (components.length) {
		lines.push({ kind: "heading", label: "components" })
		lines.push(...components)
	}

	if (trace?.kind) {
		lines.push({ kind: "heading", label: "kind" })

		lines.push({
			kind: "field",
			label: "  verdict",
			badge: trace.kind.kind,
			confidence: trace.kind.confidence,
		})

		for (const alternative of trace.kind.alternatives) {
			lines.push({ kind: "field", label: `  ${alternative.kind}`, confidence: alternative.confidence })
		}
	}

	// Advisories, never a second opinion about the answer (ROAD_TO_V9 §4) — carried on the RESULT, so they
	// survive even when the register was pinned and there is no kind verdict above them.
	for (const marker of result.intent_markers ?? []) {
		lines.push({ kind: "field", label: `  ${marker.code}`, value: marker.mechanism, detail: marker.message })
	}

	if (timing) {
		lines.push({ kind: "heading", label: "timing" })

		for (const [phase, ms] of Object.entries(timing)) {
			lines.push({ kind: "field", label: `  ${phase}`, value: formatMsFixed(ms) })
		}
	}

	lines.push({ kind: "heading", label: "resolved" })

	lines.push({
		kind: "field",
		label: "  tier",
		badge: result.resolution_tier,
		// An admin centroid is the fallback answer, not the house-grade one the other tiers promise.
		badgeColor: result.resolution_tier === "admin" ? "yellow" : "green",
	})

	lines.push({ kind: "field", label: "  coordinate", value: formatCoordinate(result.lat, result.lon) })

	lines.push({
		kind: "field",
		label: "  uncertainty",
		value: result.uncertainty_m == null ? "unknown" : `${result.uncertainty_m} m`,
	})

	// The resolved place is the DEEPEST decorated node — `hierarchy` is ordered most-specific-first, so its head is
	// the finest place the gazetteer actually confirmed. Deliberately not `candidates[0]`: that is the resolver's
	// PRIMARY node for the candidate ranking, and on a rooftop tier (where the coordinate came from a shard, not a
	// place row) it falls back to the first resolved admin node — the region, which is not what a reader means by
	// "resolved place". The candidate head still shows up below when it differs.
	const place = result.hierarchy.at(0)
	const winner = result.candidates.at(0)

	lines.push({
		kind: "field",
		label: "  place",
		tag: place?.tag ?? winner?.tag,
		value: place?.name || place?.value || winner?.name || ABSENT,
		detail: [place?.placeID ?? winner?.placeID, result.countryCode]
			.filter((part) => part != null && part.length > 0)
			.join(" "),
	})

	if (result.entity) {
		lines.push({
			kind: "field",
			label: "  entity",
			value: result.entity.name,
			detail: result.entity.categoryID ?? undefined,
			confidence: result.entity.confidence,
		})
	}

	if (result.hierarchy.length) {
		lines.push({ kind: "heading", label: "hierarchy" })

		for (const entry of result.hierarchy) {
			lines.push({
				kind: "field",
				label: `  ${entry.tag}`,
				tag: entry.tag,
				value: entry.name || entry.value,
				detail: [
					entry.placeID,
					entry.lat != null && entry.lon != null ? `(${formatCoordinate(entry.lat, entry.lon)})` : null,
				]
					.filter((part) => part != null && part.length > 0)
					.join(" "),
			})
		}
	}

	const others = result.candidates.slice(1)

	if (others.length) {
		lines.push({ kind: "heading", label: "candidates" })

		for (const candidate of others) {
			lines.push({
				kind: "field",
				label: `  ${candidate.tag}`,
				tag: candidate.tag,
				value: candidate.name,
				detail: [candidate.countryCode, formatCoordinate(candidate.lat, candidate.lon)]
					.filter((part) => part != null && part.length > 0)
					.join(" "),
			})
		}
	}

	return lines
}

//#endregion
