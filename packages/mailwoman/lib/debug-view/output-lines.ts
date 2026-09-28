/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { walkNodes, type AddressNode, type AddressTree } from "@mailwoman/core/decoder"

import { ABSENT } from "#debug-view/trace-rows"
import type { GeocodeResult } from "#geocode/result"
import type { GeocodeTrace } from "#geocode/session"

/**
 * One rendered row of the output pane; `tag` colors the label from the shared component
 * palette and `confidence` draws the demo's confidence chip.
 */
export interface OutputLine {
	/**
	 * `heading` opens a section; `error` is a failed re-run's message; `field` is everything else.
	 */
	kind: "heading" | "field" | "error"
	label: string
	value?: string
	detail?: string
	tag?: string
	/**
	 * 0..1, drawn as the confidence chip.
	 */
	confidence?: number
	/**
	 * Rendered as a badge instead of `value`, reserved for the two verdicts a reader scans for first.
	 */
	badge?: string
	/**
	 * Badge background, carried here rather than derived at render time because only
	 * this module knows an `admin` tier is a weaker answer than a rooftop.
	 */
	badgeColor?: string
}

/**
 * Six decimals ≈ 0.1 m, finer than any tier's uncertainty.
 *
 * Trailing zeros are trimmed so a four-decimal centroid still prints as four.
 */
function formatCoordinate(lat: number | null | undefined, lon: number | null | undefined): string {
	if (lat == null || lon == null) return "unresolved"

	return `${Number(lat.toFixed(6))}, ${Number(lon.toFixed(6))}`
}

/**
 * Milliseconds at one decimal, enough to tell a 3 ms decode from a 40 ms
 * resolve without implying microseconds.
 */
function formatMsFixed(ms: number): string {
	return `${ms.toFixed(1)} ms`
}

/**
 * Whether the per-span script is worth printing: the tree holds more than one writing system,
 * with `Zyyy` excluded because a house number or postcode answers it.
 */
function scriptsWorthShowing(tree: AddressTree): boolean {
	const scripts = new Set<string>()

	for (const node of walkNodes(tree.roots)) {
		if (node.script && node.script !== "Zyyy") {
			scripts.add(node.script)
		}
	}

	return scripts.size > 1
}

/**
 * Depth-first, parents before children, in span order, with children indented
 * so a street's prefix/suffix stay visibly subordinate.
 */
function componentLines(tree: AddressTree): OutputLine[] {
	const lines: OutputLine[] = []
	const showScript = scriptsWorthShowing(tree)

	const visit = (node: AddressNode, depth: number): void => {
		lines.push({
			kind: "field",
			label: `${"  ".repeat(depth)}${node.tag}`,
			tag: node.tag,
			value: node.value,
			confidence: node.confidence,
			...(showScript && node.script ? { detail: node.script } : {}),
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

export interface OutputLinesInput {
	result: GeocodeResult
	tree: AddressTree
	/**
	 * Only `kind` is read; `Pick` says so, and lets a test hand in exactly that.
	 */
	trace?: Pick<GeocodeTrace, "kind">
	/**
	 * Per-phase wall clock from the session.
	 *
	 * Absent on a caller that didn't measure, the timing section is then omitted rather than showing zeros.
	 */
	timing?: Record<string, number>
	/**
	 * A failed re-run's message, rendered first and red above a result that is
	 * deliberately still the previous one.
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

	// Advisories, never a second opinion about the answer, carried on the result
	// so they survive even when there is no kind verdict above them.
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
		// An admin centroid is the fallback answer rather than the house-grade one the other tiers promise.
		badgeColor: result.resolution_tier === "admin" ? "yellow" : "green",
	})

	lines.push({ kind: "field", label: "  coordinate", value: formatCoordinate(result.lat, result.lon) })

	lines.push({
		kind: "field",
		label: "  uncertainty",
		value: result.uncertainty_m == null ? "unknown" : `${result.uncertainty_m} m`,
	})

	// The resolved place is the deepest decorated node (`hierarchy[0]`), deliberately not
	// `candidates[0]`, which can fall back to the first resolved admin node.
	const place = result.hierarchy.at(0)
	const winner = result.candidates.at(0)

	lines.push({
		kind: "field",
		label: "  place",
		tag: place?.tag ?? winner?.tag,
		value: place?.name || place?.value || winner?.name || ABSENT,
		detail: [place?.placeID ?? winner?.placeID, result.countryCode]
			.filter((part) => part != null && part.length)
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
					.filter((part) => part != null && part.length)
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
					.filter((part) => part != null && part.length)
					.join(" "),
			})
		}
	}

	return lines
}
