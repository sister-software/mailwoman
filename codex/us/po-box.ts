/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   USPS PO Box recognition + normalization to the surface forms that actually occur
 *   (case-insensitive, punctuated "P.O. Box", spelled-out "Post Office Box", bare "Box"). A PO box
 *   isn't a closed vocabulary like street suffixes — it's a designator phrase + a box id — so the
 *   API is a detector ({@link isPOBox}), a normalizer ({@link normalizePOBox}), and an extractor
 *   ({@link matchPOBox}) the corpus po_box synth/parsing can reuse instead of re-deriving the
 *   regex.
 * @see {@link https://pe.usps.com/text/pub28/28c2_012.htm USPS Pub 28 §29 (PO Box / Caller service)}
 */

/**
 * USPS designator phrases that introduce a post-office-box identifier, longest-first so the matcher prefers the most
 * specific phrase ("Post Office Box" before "Box"). Each is matched case-insensitively with flexible internal
 * punctuation/spacing.
 */
export const US_PO_BOX_DESIGNATORS = [
	"POST OFFICE BOX",
	"PO BOX",
	"P O BOX",
	"FIRM CALLER",
	"CALLER",
	"DRAWER",
	"LOCKBOX",
	"BOX",
] as const satisfies readonly string[]

export type UsPoBoxDesignator = (typeof US_PO_BOX_DESIGNATORS)[number]

// Matches a leading PO-box designator + its identifier. Allows "P.O. Box", "PO BOX", "Post Office
// Box", "Box 12-A", etc. The id is alphanumeric with optional dashes (USPS caller/firm ids exist).
const PO_BOX_RE =
	/^\s*(?:(p\.?\s*o\.?\s*box)|(post\s+office\s+box)|(firm\s+caller)|(caller)|(drawer)|(lockbox)|(box))\s*#?\s*([\dA-Za-z][\dA-Za-z-]*)\s*$/i

/**
 * Type-predicate: does the input look like a standalone PO Box address? Case-insensitive and tolerant of "P.O. Box",
 * "Post Office Box", "Box 12", "PMB"-style ids. (Widens the original isp-nexus `/^PO BOX [\d-]+$/`, which only matched
 * all-caps "PO BOX 123".)
 */
export function isPOBox(input: unknown): boolean {
	return typeof input === "string" && PO_BOX_RE.test(input)
}

/** Result of a PO-box parse: the matched designator phrase and the box identifier. */
export interface PoBoxMatch {
	/** The designator phrase as it appeared, e.g. "P.O. Box", "Post Office Box". */
	matched: string
	/** The box identifier, e.g. "123", "12-A". */
	id: string
}

/**
 * If `input` is a PO-box phrase ("PO Box 123", "P.O. Box 12-A", "Post Office Box 7"), return the designator phrase and
 * the id. Null otherwise. Useful for the corpus po_box shard (split the designator from the number) and for
 * resolver/parsing reuse.
 */
export function matchPOBox(input: unknown): PoBoxMatch | null {
	if (typeof input !== "string") return null
	const m = PO_BOX_RE.exec(input)

	if (!m) return null
	const matched = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? m[7] ?? "").trim()
	const id = m[8]!

	return { matched, id }
}

/**
 * Normalize any recognized PO-box phrase to the canonical USPS "PO BOX <id>" form. Returns the input unchanged if it
 * isn't a PO box. (Widens the original isp-nexus normalizer, which only collapsed the "P.O. BOX" spelling and left the
 * id/casing alone.)
 */
export function normalizePOBox(input: string): string {
	const m = matchPOBox(input)

	if (!m) return input

	return `PO BOX ${m.id.toUpperCase()}`
}
