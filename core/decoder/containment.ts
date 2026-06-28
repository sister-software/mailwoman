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
 *   Tags absent from a map are treated as root-only (no parent ever accepted).
 *
 *   ## Per-system containment (anti-lock-in)
 *
 *   Addressing _systems_ disagree on hierarchy: a US street address nests `house_number → street →
 *   locality`, while a Japanese block address nests `building_number → sub_block → block →
 *   district` — there is no `street` parent at all. Today a single global map suffices only because
 *   the tag sets don't collide, but the moment the resolver or tree builder hardcodes the Western
 *   shape, retrofitting a second system gets expensive (DeepSeek resolver consult, 2026-05-30).
 *
 *   The cheap insurance is this indirection: callers ask `containmentFor(system)` rather than
 *   importing one global constant. Today every system resolves to `WESTERN_PARENT_OF` (the
 *   historical map, behavior-identical), and `PARENT_OF` is kept as an alias so existing imports
 *   don't break. When a distinct system map lands (Phase 6 JP), it slots in here with zero
 *   call-site churn. See `AddressSystem` in `./types.ts`.
 */

import type { ComponentTag } from "../types/component.js"
import type { AddressSystem } from "./types.js"

/** Preferred-parent ordering for each tag. Empty / missing = always root. */
export const WESTERN_PARENT_OF: Partial<Record<ComponentTag, ComponentTag[]>> = {
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

	// JP — declared for forward-compat; mapping is provisional and will be revisited in Phase 6, when
	// a dedicated `japanese` system map likely supersedes these entries with a no-street hierarchy.
	prefecture: ["country"],
	municipality: ["prefecture"],
	district: ["municipality"],
	block: ["district"],
	sub_block: ["block"],
	building_number: ["sub_block", "block"],
	building_name: ["building_number", "sub_block", "block"],
}

/**
 * The containment map for a given addressing system.
 *
 * Currently every system maps to {@link WESTERN_PARENT_OF} — the indirection exists so a future system-specific map
 * (e.g. Japanese block addressing) can be introduced without touching the tree builder or validator. `undefined` (the
 * common case — system not yet detected) uses the default.
 */
export function containmentFor(_system?: AddressSystem): Partial<Record<ComponentTag, ComponentTag[]>> {
	// Single system today. The parameter is intentionally consumed lazily — adding `case "japanese":`
	// here is the entire surface area for a new system's hierarchy.
	return WESTERN_PARENT_OF
}

/**
 * Backwards-compatible alias for the default (Western) containment map. Prefer `containmentFor()` in new code so the
 * system parameter threads through; this export remains for existing call sites.
 */
export const PARENT_OF = WESTERN_PARENT_OF
