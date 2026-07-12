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
	country: "country",
	country_region: "country_region",
	world_region: "world_region",
}

/** Map raw Mailwoman matches to libpostal's ordered `[{label, value}]` shape. */
export function toLibpostalComponents(matches: ParseMatch[]): LibpostalComponent[] {
	return matches.map((m) => ({ label: COMPONENT_TO_LIBPOSTAL[m.classification] ?? m.classification, value: m.value }))
}

/**
 * The parsing engine the router delegates to. `parse` is required; `expand` is optional (a missing one answers `501`).
 * The CLI wires `parse` to Mailwoman's `createAddressParser` and `expand` to `@mailwoman/normalize`.
 */
export interface LibpostalEngine {
	parse(query: string): Promise<ParseMatch[]>
	expand?(address: string): Promise<string[]>
}
