/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The inverse of the per-slice postcode patterns: given a postcode string, which address SYSTEMS
 *   could it belong to? Each codex slice owns its own postcode shape (`us` accepts
 *   `\d{5}(-\d{4})?`, `ca` accepts `A1A 1A1`, `jp` accepts `NNN-NNNN`, …); this is the single place
 *   that asks all of them at once and collects the matches.
 *
 *   It is the shared source of truth for "which systems can this shape be" — consumed by the postcode
 *   anchor (to narrow which systems' street vocabularies it checks) and, in time, by the runtime
 *   pipeline's locale gate (so its format→locale scoring derives from the same patterns rather than
 *   a second, divergent copy). The point is to unify the DATA, not to couple the modules: callers
 *   depend on this pure function, never on each other.
 *
 *   Note this is a SHAPE test, not a gazetteer-membership test. A bare `68161` matches the US,
 *   German, AND French 5-digit shapes, so it returns `["us", "de", "fr"]` — the shape alone cannot
 *   split the numeric-postcode systems. The anchor uses real gazetteer membership for the finer
 *   call; this function answers the coarser, model-free "which systems is this shape even eligible
 *   for".
 */

import { normalizeCaPostalCode } from "./ca/index.js"
import { normalizePLZ } from "./de/index.js"
import { normalizeCodePostal } from "./fr/index.js"
import { normalizeUkPostcode } from "./gb/index.js"
import { normalizeJpPostalCode } from "./jp/index.js"
import { isZipCode } from "./us/index.js"

/** A codex address-system code — the subpath under `@mailwoman/codex/<system>`. */
export type SystemCode = "us" | "de" | "fr" | "ca" | "gb" | "jp"

/**
 * Per-system membership test: each entry returns true when the string is accepted by that system's
 * own postcode shape (after that system's normalization — so `D-68161` reaches `de`, `1012 LM`
 * reaches nothing here since NL has no slice yet, etc.). Ordered for a stable, alphabetical-ish
 * result.
 */
const SYSTEM_ACCEPTS: ReadonlyArray<readonly [SystemCode, (s: string) => boolean]> = [
	["us", (s) => isZipCode(s)],
	["de", (s) => normalizePLZ(s) !== null],
	["fr", (s) => normalizeCodePostal(s) !== null],
	["ca", (s) => normalizeCaPostalCode(s) !== null],
	["gb", (s) => normalizeUkPostcode(s) !== null],
	["jp", (s) => normalizeJpPostalCode(s) !== null],
]

/**
 * Every address system whose own postcode shape accepts `postcode`. Empty when no system recognizes
 * the shape (e.g. a bare `27`, or a 7-digit run). O(number of systems) — a handful of cheap regex
 * tests, run only on the few postcode-shaped spans an address contains.
 */
export function candidateSystemsForPostcode(postcode: string): SystemCode[] {
	if (typeof postcode !== "string" || postcode.length === 0) return []
	const out: SystemCode[] = []
	for (const [system, accepts] of SYSTEM_ACCEPTS) {
		if (accepts(postcode)) out.push(system)
	}
	return out
}
