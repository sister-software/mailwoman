/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-address-system parsing conventions (#478's rules-as-constraints slice, started as the #511
 *   Tier A corrective). The model's locale head detects WHICH address system a string belongs to;
 *   this table says what is and isn't grammatical in that system, so the decoder can obey the
 *   detection instead of merely being nudged by it.
 *
 *   Every row is a provenance-carrying claim about a national addressing convention — the same
 *   no-load-bearing-trivia discipline as the rest of the codex. Add rows with a source, not from
 *   vibes; an absent row means "no constraints known", never "no constraints exist".
 *
 *   First consumer: `@mailwoman/neural`'s decoder applies `forbiddenTags` as a hard emission mask
 *   before Viterbi and treats `postcodePattern` as the system's canonical shape for the snap-only
 *   postcode repair pass. Both triggered only when the system is detected confidently (or supplied
 *   by the caller) — an undetected system parses exactly as before.
 */

import { CODE_POSTAL_PATTERN } from "./fr/code-postal.js"
import type { SystemCode } from "./postcode-systems.js"

export interface AddressSystemConventions {
	/**
	 * Component tags that are NOT grammatical in this address system (names from the core
	 * `ComponentTag` union; codex stays dependency-free so they are plain strings here).
	 */
	readonly forbiddenTags?: readonly string[]
	/**
	 * The system's canonical postcode shape. A decoded postcode span that is a strict sub-match of a
	 * pattern-valid string in the raw text is shape-INVALID for this system and eligible for the
	 * snap-only repair (extend/clip to the valid match — never invent a span).
	 */
	readonly postcodePattern?: RegExp
}

export const ADDRESS_SYSTEM_CONVENTIONS: Partial<Record<SystemCode, AddressSystemConventions>> = {
	/**
	 * France (La Poste / AFNOR NF Z 10-011): street types are LEADING particles of the street name
	 * ("Rue de Rivoli", "Avenue des Champs-Élysées") — the libpostal French dictionaries carry no
	 * trailing street-suffix class, and the USPS Pub-28 prefix/suffix decomposition has no French
	 * counterpart. `street_prefix`/`street_suffix` therefore cannot occur in a French parse; any such
	 * emission is US-convention leakage (measured: the 2026-06-10 v1.1.0 gate, where USPS suffix
	 * logic fired on "Rue" — RUE is genuinely a Pub-28 suffix variant — and digit-splits corrupted
	 * leading postcodes). Postcode: exactly five digits (NF Z 10-011; see fr/code-postal).
	 */
	fr: {
		forbiddenTags: ["street_prefix", "street_suffix"],
		postcodePattern: CODE_POSTAL_PATTERN,
	},
}

/** Look up conventions for a system. Absent row = no constraints KNOWN (parse unconstrained). */
export function conventionsForSystem(system: SystemCode | null | undefined): AddressSystemConventions | null {
	if (!system) return null
	return ADDRESS_SYSTEM_CONVENTIONS[system] ?? null
}
