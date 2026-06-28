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
 *   provenance-first discipline as the rest of the codex. Add rows with a source, not from vibes;
 *   an absent row means "no constraints known", never "no constraints exist".
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
	 * Component tags that are NOT grammatical in this address system (names from the core `ComponentTag` union; codex
	 * stays dependency-free so they are plain strings here).
	 */
	readonly forbiddenTags?: readonly string[]
	/**
	 * The system's canonical postcode shape. A decoded postcode span that is a strict sub-match of a pattern-valid string
	 * in the raw text is shape-INVALID for this system and eligible for the snap-only repair (extend/clip to the valid
	 * match — never invent a span).
	 */
	readonly postcodePattern?: RegExp
}

export const ADDRESS_SYSTEM_CONVENTIONS: Partial<Record<SystemCode, AddressSystemConventions>> = {
	/**
	 * France (La Poste / AFNOR NF Z 10-011): the street TYPE is a LEADING particle of the street name ("Rue de Rivoli",
	 * "Avenue des Champs-Élysées", "Cours Lafayette") and is labeled `street_prefix` — French addresses DO carry a
	 * street_prefix, just never a trailing USPS-style street_suffix (the libpostal French dictionaries have no trailing
	 * street-suffix class; Pub-28's suffix decomposition has no French counterpart).
	 *
	 * Provenance / why this is NOT a blanket prefix+suffix forbid (#719, 2026-06-18): an earlier model mis-tagged the
	 * leading "Rue" as a US-style `street_suffix` (RUE is a Pub-28 suffix variant) — the 2026-06-10 v1.1.0 gate — so #511
	 * forbade BOTH affix tags to stop that leakage. That forbid was correct for THAT model but became a live production
	 * bug for the current one: the shipped model (v1.5.0) emits the FR `street_prefix` correctly, but the conventions
	 * mask was a hard −1e9 on every B-/I-street_prefix emission, so the detected-FR parse could never KEEP a prefix — it
	 * destroyed `street_prefix` wholesale (measured on data/eval/external/ fr-street-prefix-real.jsonl at
	 * conventions=auto: F1 0.0 with the forbid on → 80.0 with it off; the larger real-FR eval reported the same collapse,
	 * ~96 → ~0.6). We keep ONLY `street_suffix` forbidden: the current model with the forbid OFF shows zero FR
	 * street_suffix leakage (fp=0 on that same slice) and FR has no trailing street suffix, so the constraint costs
	 * nothing while still guarding against any future suffix mis-tag. Postcode: exactly five digits (NF Z 10-011; see
	 * fr/code-postal).
	 */
	fr: {
		forbiddenTags: ["street_suffix"],
		postcodePattern: CODE_POSTAL_PATTERN,
	},
}

/** Look up conventions for a system. Absent row = no constraints KNOWN (parse unconstrained). */
export function conventionsForSystem(system: SystemCode | null | undefined): AddressSystemConventions | null {
	if (!system) return null

	return ADDRESS_SYSTEM_CONVENTIONS[system] ?? null
}
