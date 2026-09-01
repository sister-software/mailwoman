/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared plumbing for the Latin off-map outlier builders (`build-outlier-latin.ts` — Overture,
 *   `build-outlier-oa.ts` — OpenAddresses): the address-string assembler and its shape variants,
 *   the dedup/cap loop, and the OTHER-row JSONL encoding. The builders differ only in where the
 *   locality comes from and in OA's PO-box guard, so both are parameters here.
 */

import { hashFNV1a } from "#coarse-placer/fnv-hash"

/**
 * Shortest raw string worth keeping as an outlier example; below it there is nothing to learn from.
 */
const MIN_OUTLIER_LENGTH = 6

/**
 * Address parts are joined positionally; an absent field arrives as the empty string and must not become a stray
 * separator.
 */
const nonEmpty = (part: string): boolean => part.length > 0

/**
 * How {@link assembleOutlierRow} varies per source.
 */
export interface AssembleOutlierOptions {
	/**
	 * Derive the locality string from the source row (Overture: `postal_city` falling back to `address_levels`; OA:
	 * `city`).
	 */
	locality: (row: Record<string, unknown>) => string
	/**
	 * Drop raw-coord-only / PO-box-ish noise (the OA failure mode): without a street, the locality must carry a real word
	 * character.
	 */
	requireLetterLocality?: boolean
}

/**
 * Assemble a plausible address string from a source row. Deterministic shape variant by hash.
 */
export function assembleOutlierRow(row: Record<string, unknown>, options: AssembleOutlierOptions): string | null {
	const num = (row.number ?? "").toString().trim()
	const street = (row.street ?? "").toString().trim()
	const pc = (row.postcode ?? "").toString().trim()
	const locality = options.locality(row)

	// Nothing distinctive to learn from.
	if (!street && !locality) return null

	if (options.requireLetterLocality && !street && !/[a-z]/i.test(locality)) return null

	const head = [num, street].filter(nonEmpty).join(" ")
	const h = hashFNV1a(`${num}|${street}|${pc}|${locality}`)

	switch (h % 3) {
		case 0:
			return [head, [pc, locality].filter(nonEmpty).join(" ")].filter(nonEmpty).join(", ")
		case 1:
			return [head, locality, pc].filter(nonEmpty).join(", ").trim()
		default:
			return [head, [locality, pc].filter(nonEmpty).join(" ")].filter(nonEmpty).join(", ")
	}
}

/**
 * Dedup assembled rows, dropping nulls and strings under {@link MIN_OUTLIER_LENGTH}, keeping at most `cap`.
 */
export function collectOutlierRows(candidates: Iterable<string | null>, cap = Infinity): string[] {
	const seen = new Set<string>()
	const out: string[] = []

	for (const raw of candidates) {
		if (!raw || raw.length < MIN_OUTLIER_LENGTH || seen.has(raw)) continue
		seen.add(raw)
		out.push(raw)

		if (out.length >= cap) break
	}

	return out
}

/**
 * Encode rows as `{raw, country: "OTHER"}` JSONL (trailing newline included).
 */
export function otherRowsJSONL(rows: string[]): string {
	return rows.map((raw) => JSON.stringify({ raw, country: "OTHER" })).join("\n") + "\n"
}
