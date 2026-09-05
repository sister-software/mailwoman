/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Background color per `ComponentTag`, for the debug view's span ribbon (`DebugFrame.tsx`). One
 *   color family per address-component group — street-level greens/blues, admin-hierarchy
 *   ambers/purples, venue-level oranges — so a glance at the ribbon shows which spans are related
 *   without reading the tag text underneath. Hex strings: Ink/chalk accept `backgroundColor="#rrggbb"`
 *   directly, so no named-color lookup table is needed downstream.
 */

import type { ComponentTag } from "@mailwoman/core/types"

const TAG_COLORS: Partial<Record<ComponentTag, string>> = {
	// Admin hierarchy — ambers (locality-ish) and purples (country/unit)
	country: "#6e40c9",
	region: "#9a6700",
	subregion: "#9a6700",
	locality: "#bf8700",
	dependent_locality: "#bf8700",
	postcode: "#cf222e",
	// Street-level — greens (thoroughfare) and blue (house number)
	house_number: "#1f6feb",
	street: "#2ea043",
	street_prefix: "#2ea043",
	street_prefix_particle: "#2ea043",
	street_suffix: "#2ea043",
	intersection_a: "#2ea043",
	intersection_b: "#2ea043",
	unit: "#8957e5",
	// Venue-level — oranges
	venue: "#bc4c00",
	attention: "#bc4c00",
	po_box: "#bc4c00",
	// FR-specific
	cedex: "#cf222e",
	// JP block addressing — reuses the admin/street families it stands in for
	prefecture: "#9a6700",
	municipality: "#bf8700",
	district: "#bf8700",
	block: "#57606a",
	sub_block: "#57606a",
	building_number: "#1f6feb",
	building_name: "#bc4c00",
	// CN organizational chain — the admin family it sits below
	locality_unit: "#bf8700",
}

/**
 * Neutral dark gray for any tag not in the table above — a future `ComponentTag` addition, or a stray string. The
 * ribbon degrades to an unstyled segment, never a crash or a lookup throw.
 */
const DEFAULT_TAG_COLOR = "#3d444d"

/**
 * Background color for a component tag's span-ribbon segment.
 */
export function tagColor(tag: string): string {
	return TAG_COLORS[tag as ComponentTag] ?? DEFAULT_TAG_COLOR
}
