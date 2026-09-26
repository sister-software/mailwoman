/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-address-system parsing conventions: what is and isn't grammatical in the address system the
 *   model's locale head detects, so the decoder can obey the detection rather than merely being
 *   nudged by it.
 *
 *   Every row is a provenance-carrying claim about a national addressing convention; add rows with a
 *   source rather than from vibes. An absent row means "no constraints known", never "no constraints
 *   exist".
 *
 *   `@mailwoman/neural`'s decoder applies `forbiddenTags` as a hard emission mask before Viterbi and
 *   treats `postcodePattern` as the system's canonical shape for the snap-only postcode repair pass.
 *   Both trigger only when the system is detected confidently (or supplied by the caller); an
 *   undetected system parses exactly as before.
 */

import type { ComponentTag } from "#component"
import { CODE_POSTAL_PATTERN } from "#fr/code-postal"
import { UK_POSTCODE_PATTERN } from "#gb/postcode/index"
import type { SystemCode } from "#postcode/systems"

export interface AddressSystemConventions {
	readonly forbiddenTags?: readonly ComponentTag[]
	/**
	 * The system's canonical postcode shape; a decoded span that is a strict sub-match
	 * of a pattern-valid string in the raw text is shape-invalid and eligible for the
	 * snap-only repair (extend/clip to the valid match, never invent a span).
	 */
	readonly postcodePattern?: RegExp
}

/**
 * Per-address-system ordering and formatting conventions, keyed by address system
 * rather than country since several countries share one.
 */
export const ADDRESS_SYSTEM_CONVENTIONS: Partial<Record<SystemCode, AddressSystemConventions>> = {
	/**
	 * France (La Poste / afnor NF Z 10-011): the street type is a leading particle labeled `street_prefix`
	 * ("Rue de Rivoli"), and French addresses never carry a trailing USPS-style `street_suffix`.
	 *
	 * Postcode: exactly five digits (NF Z 10-011; see fr/code-postal).
	 */
	fr: {
		forbiddenTags: ["street_suffix"],
		postcodePattern: CODE_POSTAL_PATTERN,
	},

	/**
	 * United Kingdom (Royal Mail / UK-gov postcode shape): variable-length alphanumeric outward +
	 * inward (`SW1A 1AA`, `M1 1AE`, `SK11 9PD`), the most complex shape of any system in the codex.
	 *
	 * The model fragments that shape (`SK11 9PD` → region "S" + postcode "K11 9PD"), and a fragment is
	 * a strict sub-match of the pattern-valid string — exactly the class `postcodePattern` flags.
	 *
	 * No `forbiddenTags`: no GB-ungrammatical tag class is known, and a forbid
	 * needs measured zero-cost receipts.
	 */
	gb: {
		postcodePattern: UK_POSTCODE_PATTERN,
	},
}

/**
 * Look up conventions for a system; an absent row means no constraints are known (parse unconstrained).
 */
export function conventionsForSystem(system: SystemCode | null | undefined): AddressSystemConventions | null {
	if (!system) return null

	return ADDRESS_SYSTEM_CONVENTIONS[system] ?? null
}
