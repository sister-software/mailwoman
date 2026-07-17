/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Engine contract + the `ComponentTag` → libpostal-label mapping. libpostal-specific knowledge
 *   lives here; the engine yields raw Mailwoman matches (a `ComponentTag` classification + covered
 *   text) and {@link toLibpostalComponents} serializes them to libpostal's ordered `[{label,
 *   value}]` shape.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"

/** A libpostal `parse_address` component: a label + the text it covers, in order. */
export interface LibpostalComponent {
	label: string
	value: string
}

/** A raw Mailwoman match the engine yields (our `ComponentTag` classification + the covered text). */
export interface ParseMatch {
	classification: string
	value: string
}

/**
 * Mailwoman `ComponentTag` → libpostal label. libpostal's label set is OSM-derived; ours is close but not identical, so
 * map the overlap and pass unmapped classifications through unchanged.
 */
export const COMPONENT_TO_LIBPOSTAL: Record<string, string> = {
	house_number: "house_number",
	street: "road",
	venue: "house",
	house: "house",
	unit: "unit",
	level: "level",
	po_box: "po_box",
	postcode: "postcode",
	locality: "city",
	dependent_locality: "suburb",
	neighbourhood: "suburb",
	borough: "city_district",
	region: "state",
	macroregion: "state_district",
	subregion: "state_district",
	intersection_a: "road",
	intersection_b: "road",
	country: "country",
	country_region: "country_region",
	world_region: "world_region",
}

/** Map raw Mailwoman matches to libpostal's ordered `[{label, value}]` shape. */
export function toLibpostalComponents(matches: ParseMatch[]): LibpostalComponent[] {
	return matches.map((m) => ({ label: COMPONENT_TO_LIBPOSTAL[m.classification] ?? m.classification, value: m.value }))
}

/** The street-name family assembled into a single `street` match (mirrors geocode-core's assembleStreetName). */
const STREET_NAME_TAGS = new Set(["street", "street_prefix", "street_prefix_particle", "street_suffix"])

/**
 * Flatten a neural `AddressTree` to reading-order raw matches for {@link LibpostalEngine.parse}. The street node and
 * its street-name children collapse into ONE `street` match (libpostal's `road` is the full name); other children
 * (house_number, unit) emit as their own matches. Values join with a single space — original inter-part punctuation is
 * not reconstructed.
 */
export function treeToParseMatches(tree: AddressTree): ParseMatch[] {
	const spans: Array<{ start: number; classification: string; value: string }> = []

	const visit = (node: AddressNode): void => {
		if (node.tag === "street") {
			const nameParts = [node, ...node.children.filter((child) => STREET_NAME_TAGS.has(child.tag))].sort(
				(a, b) => a.start - b.start || a.end - b.end
			)
			const first = nameParts[0]

			if (first) {
				spans.push({ start: first.start, classification: "street", value: nameParts.map((p) => p.value).join(" ") })
			}

			for (const child of node.children) {
				if (!STREET_NAME_TAGS.has(child.tag)) {
					visit(child)
				}
			}

			return
		}

		spans.push({ start: node.start, classification: node.tag, value: node.value })

		for (const child of node.children) {
			visit(child)
		}
	}

	for (const root of tree.roots) {
		visit(root)
	}

	return spans.sort((a, b) => a.start - b.start).map(({ classification, value }) => ({ classification, value }))
}

/**
 * The parsing engine the router delegates to. `parse` is required; `expand` is optional (a missing one answers `501`).
 * The CLI wires `parse` to Mailwoman's `createAddressParser` and `expand` to `@mailwoman/normalize`.
 */
export interface LibpostalEngine {
	parse(query: string): Promise<ParseMatch[]>
	expand?(address: string): Promise<string[]>
}
