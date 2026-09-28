/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Gauntlet's per-case grader: one stored case + one assembled result → the list of mismatches.
 */

import { COMPONENT_TAGS } from "@mailwoman/codex/component"
import { tryParsingJSON } from "@mailwoman/core/json"
import { haversineKm } from "@mailwoman/spatial"

import type { GauntletResult } from "#eval-harness/gauntlet/harness"
import type { GauntletCaseTable } from "#eval-harness/gauntlet/schema"

/**
 * Great-circle tolerance applied when a case pins a coordinate but no `expect_tolerance_m`.
 */
export const DEFAULT_TOL_M = 5000

/**
 * Map an expect_components key to the assembled-result field it asserts.
 *
 * The ablation layer scores a deletion against this same slot, so a second copy of the
 * mapping could let the two disagree about which field a key lives in.
 */
export function componentOf(r: GauntletResult, key: string): string | null {
	switch (key) {
		case "country":
			return r.country
		case "region":
			return r.region
		case "locality":
			return r.locality
		case "house_number":
			return r.house_number
		case "street":
			return r.street
		case "postcode":
			return r.postcode
		case "venue":
			return r.venue
		case "dependent_locality":
			return r.dependent_locality
		case "unit":
			return r.unit
		default:
			if (COMPONENT_TAGS.includes(key as (typeof COMPONENT_TAGS)[number])) {
				return r.components[key as (typeof COMPONENT_TAGS)[number]] ?? null
			}

			// An unknown key is an authoring bug, so this throws rather than returning a null that grades as a pass.
			throw new Error(`expect_components key "${key}" has no GauntletResult mapping — extend componentOf`)
	}
}

/**
 * The script families a component value can be written in, for the dual-script comparison below.
 *
 * Grouped rather than per-Unicode-script because one Japanese rendering routinely mixes Han
 * and kana within one word (`表参道ヒルズ`) and splitting there would shred it. an unlisted
 * script collapses to one `"other"` run rather than being shredded.
 */
const SCRIPT_FAMILIES: ReadonlyArray<readonly [string, RegExp]> = [
	["latin", /\p{Script=Latin}/u],
	["cyrillic", /\p{Script=Cyrillic}/u],
	["cjk", /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u],
	["greek", /\p{Script=Greek}/u],
	["arabic", /\p{Script=Arabic}/u],
	["hebrew", /\p{Script=Hebrew}/u],
	["devanagari", /\p{Script=Devanagari}/u],
	["thai", /\p{Script=Thai}/u],
]

/**
 * The script family of one character, or `null` for a scriptless character
 * (digits, punctuation, whitespace, combining marks) that belongs to whichever rendering surrounds it.
 */
function scriptFamilyOf(char: string): string | null {
	if (!/\p{L}/u.test(char)) return null

	for (const [family, re] of SCRIPT_FAMILIES) {
		if (re.test(char)) return family
	}

	return "other"
}

/**
 * Split a component value into one rendering per script family, in source order.
 *
 * A mono-script value yields exactly one rendering, so it can never satisfy an interface that lists two.
 * Only rows that opt into `expect_component_renderings` (see {@linkcode checkCase})
 * reach this, because ordinary component assertions use exact equality.
 */
export function scriptRenderings(value: string): string[] {
	const renderings: string[] = []
	let family: string | null = null
	let chars: string[] = []
	let pending: string[] = []

	for (const char of value) {
		const charFamily = scriptFamilyOf(char)

		if (charFamily === null) {
			pending.push(char)

			continue
		}

		if (charFamily === family) {
			// Same family across the gap: the neutrals were interior rather than a joiner, so keep them.
			chars.push(...pending, char)
		} else {
			if (chars.length) {
				renderings.push(chars.join(""))
			}

			family = charFamily
			chars = [char]
		}

		pending = []
	}

	if (chars.length) {
		renderings.push(chars.join(""))
	}

	return renderings
}

/**
 * Does `got` satisfy the asserted `expected`?
 *
 * Exact case-folded equality with no other rule for every ordinary `expect_components` key. a
 * global fallback over {@linkcode scriptRenderings} was removed because two renderings of a value
 * cannot say whether they are two writings of the same element or two elements that ran together,
 * so the relaxation lives in the per-row `expect_component_renderings` opt-in instead.
 */
export function componentMatches(got: string, expected: string): boolean {
	return got.toLowerCase() === expected.toLowerCase()
}

/**
 * Which of the required renderings are absent from {@linkcode scriptRenderings}`(got)`, case-folded.
 *
 * Empty means the interface is satisfied and no other property of `got` is asserted.
 */
function missingRenderings(got: string, required: readonly string[]): string[] {
	const present = new Set(scriptRenderings(got).map((rendering) => rendering.toLowerCase()))

	return required.filter((rendering) => !present.has(rendering.toLowerCase()))
}

/**
 * The resolved place an `expect_place_id` / `expect_place_name` row grades against:
 * the most specific admin node the resolver decorated, where `hierarchy` is sorted locality
 * → dependent_locality → subregion → region → country; {@linkcode GauntletResult.locality}
 * would be wrong because it echoes the parsed query span, while `hierarchy[].name` is the
 * gazetteer's canonical `resolver_name`, the only field that can disagree with the input.
 */
function resolvedPlace(r: GauntletResult): GauntletResult["hierarchy"][number] | undefined {
	return r.hierarchy[0]
}

/**
 * Assert one assembled result against its stored case, returning the mismatches (empty = the case passes).
 *
 * Every check is opt-in per row.
 * Components are checked last because corrupt `expect_components` JSON short-circuits
 * its own check while the place check must still have run.
 */
export function checkCase(c: GauntletCaseTable, r: GauntletResult): string[] {
	const issues: string[] = []

	// Abstain inverts the grade: any resolved coordinate fails.
	// A row that also pins a coordinate is an authoring bug that throws rather than a precedence question.
	if (c.expect_abstain) {
		if (c.expect_lat != null || c.expect_lon != null) {
			throw new Error(`case ${c.id}: expect_abstain and expect_lat/expect_lon are mutually exclusive`)
		}

		if (r.lat != null && r.lon != null) {
			issues.push(`resolved (${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}) ≠ abstain`)
		}
	}

	if (c.expect_lat != null && c.expect_lon != null) {
		const tolKm = (c.expect_tolerance_m ?? DEFAULT_TOL_M) / 1000
		const km = r.lat != null && r.lon != null ? haversineKm(r.lat, r.lon, c.expect_lat, c.expect_lon) : Infinity

		if (km > tolKm) {
			issues.push(
				`coord ${km === Infinity ? "unresolved" : `${km.toFixed(2)}km off`} (tol ${c.expect_tolerance_m ?? DEFAULT_TOL_M}m)`
			)
		}
	}

	if (c.expect_tier != null && r.tier !== c.expect_tier) {
		issues.push(`tier ${r.tier} ≠ ${c.expect_tier}`)
	}

	if (c.expect_place_id != null || c.expect_place_name != null) {
		const place = resolvedPlace(r)

		if (!place) {
			issues.push(
				`place unresolved (hierarchy empty) ≠ ${c.expect_place_name ? `"${c.expect_place_name}"` : c.expect_place_id}`
			)
		} else {
			// Case-insensitive, matching the component check: casing is the gazetteer's business,
			// as `resolver_name` is proper-cased canonical.
			if (c.expect_place_name != null && place.name.toLowerCase() !== c.expect_place_name.toLowerCase()) {
				issues.push(`place name "${place.name}" ≠ "${c.expect_place_name}"`)
			}

			// Exact, unlike the name: a place id is an opaque key rather than prose.
			if (c.expect_place_id != null && place.placeID !== c.expect_place_id) {
				issues.push(`place id "${place.placeID ?? null}" ≠ "${c.expect_place_id}"`)
			}
		}
	}

	// Parsed ahead of the expect_components loop because its keys take precedence there;
	// `undefined` is tolerated alongside null because an older regression.db has no such column.
	const renderinginterface =
		c.expect_component_renderings != null
			? tryParsingJSON<Record<string, string[]>>(c.expect_component_renderings)
			: null

	if (c.expect_component_renderings != null && !renderinginterface) {
		issues.push(`expect_component_renderings is not valid JSON (corrupt regression.db row?)`)
	}

	if (c.expect_components != null) {
		// From our own builder's JSON.stringify, so malformed means a corrupt DB row — surface
		// it as a per-case issue rather than letting a raw SyntaxError kill the whole check.
		const exp = tryParsingJSON<Record<string, string>>(c.expect_components)

		if (!exp) {
			issues.push(`expect_components is not valid JSON (corrupt regression.db row?)`)
		} else {
			for (const [k, v] of Object.entries(exp)) {
				// Superseded: the rendering interface owns this key outright.
				if (renderinginterface && k in renderinginterface) continue

				const got = componentOf(r, k)

				if (!componentMatches(got ?? "", v)) {
					issues.push(`${k} "${got}" ≠ "${v}"`)
				}
			}
		}
	}

	if (renderinginterface) {
		for (const [k, required] of Object.entries(renderinginterface)) {
			// An empty or non-string-array list would assert no rendering while looking asserted.
			// the seed schema refuses these on load, so reaching one here means a row bypassed it.
			if (!Array.isArray(required) || !required.length || required.some((v) => typeof v !== "string")) {
				throw new Error(
					`expect_component_renderings["${k}"] must be a non-empty string array — authoring bug (the seed schema refuses this; how was this DB built?)`
				)
			}

			const got = componentOf(r, k)
			const missing = missingRenderings(got ?? "", required)

			if (missing.length) {
				issues.push(`${k} "${got}" missing rendering(s) ${missing.map((m) => `"${m}"`).join(", ")}`)
			}
		}
	}

	return issues
}
