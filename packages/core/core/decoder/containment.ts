/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Containment rule for the address tree.
 *
 *   Each tag lists permitted parents in priority order (most-preferred first). The tree builder
 *   resolves each span's parent by walking this list and picking the first tag that has at least
 *   one labeled span; if multiple spans share that tag, the one nearest to this span in char
 *   distance wins. Spans whose tag is absent from this map (or has no labeled parent) become
 *   roots.
 *
 *   Tags absent from this map are treated as root-only (no parent ever accepted).
 */

import type { ComponentTag } from "../types/component.js"

/** Preferred-parent ordering for each tag. Empty / missing = always root. */
export const PARENT_OF: Partial<Record<ComponentTag, ComponentTag[]>> = {
	// Universal coarse — containment follows geographic granularity.
	region: ["country"],
	subregion: ["region", "country"],
	locality: ["subregion", "region", "country"],
	dependent_locality: ["locality"],
	postcode: ["locality", "subregion", "region", "country"],
	cedex: ["postcode", "locality"],

	// Street-level — street nests inside locality; house_number/unit/intersections nest inside street.
	street: ["dependent_locality", "locality", "subregion", "region"],
	street_prefix: ["street"],
	street_prefix_particle: ["street_prefix", "street"],
	street_suffix: ["street"],
	house_number: ["street"],
	unit: ["street", "house_number"],
	intersection_a: ["street", "locality"],
	intersection_b: ["street", "locality"],

	// Venue / mailing — separate top-level concepts; attach to street if labeled.
	venue: ["street", "locality"],
	attention: ["venue"],
	po_box: ["locality", "subregion", "region"],

	// JP — declared for forward-compat; mapping is provisional and will be revisited in Phase 6.
	prefecture: ["country"],
	municipality: ["prefecture"],
	district: ["municipality"],
	block: ["district"],
	sub_block: ["block"],
	building_number: ["sub_block", "block"],
	building_name: ["building_number", "sub_block", "block"],
}
