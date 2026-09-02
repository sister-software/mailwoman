/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Gauntlet's per-case grader: one stored case + one assembled result → the list of mismatches.
 *
 *   PURE, and its own module for exactly that reason. It lived inside `runRegressionLayer`'s closure until
 *   2026-08-06, where the only way to exercise it was to build the ~9 GB database set and run 306 addresses
 *   end-to-end — so the assertions this file makes had never been unit-tested, and #1507's finding (two stored
 *   expectation columns that no branch here ever read) survived every review of the layer that calls it.
 */

import { COMPONENT_TAGS } from "@mailwoman/core"
import { tryParsingJSON } from "@mailwoman/core/objects"
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
 * Exported for the ablation layer, which scores a DELETION against the same slot this check grades — a second copy of
 * the mapping would let the two disagree about which field `venue` lives in, and the ablation runner would then report
 * "the slot stayed empty" for a slot it was reading off the wrong field.
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

			// LOUD: a silent null here made venue/dependent_locality expectations grade against
			// nothing for their whole life (caught 2026-08-01). An unknown key is an authoring bug.
			throw new Error(`expect_components key "${key}" has no GauntletResult mapping — extend componentOf`)
	}
}

/**
 * The script families a component value can be written in, for the dual-script comparison below. Grouped, not
 * per-Unicode-script: Han, the two kana and Hangul are ONE family, because a single Japanese rendering routinely mixes
 * Han and kana within one word (`表参道ヒルズ`) and splitting on that boundary would shred one rendering into three.
 * Latin/Cyrillic — the pair the Mongolian rows are written in — is the case this exists for.
 *
 * Anything not listed collapses to `"other"`: an unlisted script still forms ONE run, so a value written in it is never
 * shredded, it only cannot be told apart from another unlisted script. Adding a family here is safe; the only effect is
 * that two renderings previously fused into one `"other"` run become two.
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
 * The script family of one character, or `null` when the character carries no script of its own — digits, punctuation,
 * whitespace, combining marks. Those are NEUTRAL: they belong to whichever rendering surrounds them, which is what lets
 * `BGD - 16 khoroo` stay one Latin rendering instead of four.
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
 * The dual-script rows (`mn-ws-gandantegchinlen-dual-script` and its siblings) carry the SAME address twice — a
 * Cyrillic/Mongolian rendering and a Latin/English one, slash-joined — so a parse that correctly tags BOTH produces one
 * span holding both. Each maximal run of one script family, with the neutral characters BETWEEN two letters of that
 * family absorbed into it, is one rendering; the neutrals that sit at a family BOUNDARY are the joiner and belong to
 * neither (`" / "`, `", "`, `" — "` all fall out the same way).
 *
 * A mono-script value yields exactly one rendering — the value itself, minus any leading/trailing non-letters — so it
 * can never satisfy a contract that lists two. That is the whole precision story: the splitter only ever speaks on a
 * value written in two or more scripts, and since 2026-08-11 it speaks only for the rows that OPT IN via
 * `expect_component_renderings` (see {@linkcode checkCase}) — ordinary component assertions never reach it.
 *
 * Exported for `check-case.test.ts`, which pins the family grouping directly — the JP kana case in particular has no
 * reachable expression through `checkCase` (the Latin model never emits the JP tags).
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
			// Same family across the gap — the neutrals were interior, not a joiner. Keep them.
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
 * Does `got` satisfy the asserted `expected`? EXACT case-folded equality, nothing else — the whole of the contract for
 * every ordinary `expect_components` key.
 *
 * A global set-based fallback over {@linkcode scriptRenderings} lived here briefly (2026-08-10 → 2026-08-11) so a
 * dual-script span could satisfy a truth freezing one of its renderings. Its cost was a cross-tag bleed grading as a
 * pass — the value alone cannot say whether its two renderings are two writings of the SAME element or two DIFFERENT
 * elements that ran together, so a `locality` of `四季酒家 Manchester` satisfied `Manchester`. Review converted the
 * relaxation into the per-row `expect_component_renderings` OPT-IN: a case that genuinely carries a span in two scripts
 * lists the renderings it requires, a key so listed supersedes the same key here, and every other assertion stays this
 * strict equality. See {@linkcode checkCase}'s component gate for the contract.
 */
export function componentMatches(got: string, expected: string): boolean {
	return got.toLowerCase() === expected.toLowerCase()
}

/**
 * Grade one `expect_component_renderings` entry: which of the required renderings are ABSENT from
 * {@linkcode scriptRenderings}`(got)`, case-folded? Empty = the contract is satisfied. Nothing else about `got` is
 * asserted — neutral separators between renderings, and any EXTRA rendering, ride along free.
 */
function missingRenderings(got: string, required: readonly string[]): string[] {
	const present = new Set(scriptRenderings(got).map((rendering) => rendering.toLowerCase()))

	return required.filter((rendering) => !present.has(rendering.toLowerCase()))
}

/**
 * The resolved place a `expect_place_id` / `expect_place_name` row grades against: the most specific admin node the
 * RESOLVER decorated (`hierarchy` is sorted locality → dependent_locality → subregion → region → country).
 *
 * READ THIS BEFORE CHANGING IT. The obvious-looking target, {@linkcode GauntletResult.locality}, is the wrong one: it
 * echoes the parsed QUERY SPAN (`geocode-core.ts`'s `allNodes.find(...).value`), so `Gaborone` in yields `Gaborone` out
 * no matter which place the resolver actually returned. `hierarchy[].name` is the gazetteer's canonical
 * `resolver_name`, which is the only field in the result that can disagree with the input — and disagreeing with the
 * input is the entire point of this assertion.
 */
function resolvedPlace(r: GauntletResult): GauntletResult["hierarchy"][number] | undefined {
	return r.hierarchy[0]
}

/**
 * Assert one assembled result against its stored case; returns the mismatches (empty = the case passes).
 *
 * Four independent checks, all opt-in per row — a null column asserts nothing:
 *
 * 1. COORDINATE, great-circle against `expect_tolerance_m` (default {@linkcode DEFAULT_TOL_M}).
 * 2. TIER, strict — an `address_point` that drifts to `admin` is a regression even inside tolerance.
 * 3. PLACE IDENTITY (#1507, wired 2026-08-06) — `expect_place_name` / `expect_place_id` against the resolved
 *    {@linkcode resolvedPlace}. This is the one the other three cannot express: the country sweep's family-A rows
 *    (Gaborone → the Austrian hamlet `Aichegg`, Kinshasa → `Alionys II`, Djibouti → `Ober-Himmeri`) came back with the
 *    RIGHT parsed locality and only a coordinate 8,045 km away to say so, and a row whose expected place sits inside a
 *    25 km bar of its impostor would have had nothing at all. The corpus stored both columns from the first migration
 *    and no branch read them, so "wrong place, plausible coordinate" was unassertable for the corpus's whole life.
 * 4. COMPONENTS, exact case-insensitive per key, against the parsed/assembled spans ({@linkcode componentMatches}). Last
 *    because a corrupt `expect_components` JSON short-circuits the rest of ITS gate, and the place gate must still have
 *    run. Rows whose input carries a span in two or more scripts opt in per key via `expect_component_renderings` — `{
 *    tag: [rendering, …] }` — and for a listed key the assertion becomes: {@linkcode scriptRenderings} of the got value
 *    must CONTAIN EVERY listed rendering, case-folded (both scripts required when the case defines both). Nothing else
 *    about that value is asserted. PRECEDENCE: a key present in `expect_component_renderings` supersedes the same key
 *    in `expect_components`; an empty rendering list throws (an authoring bug the seed schema refuses upstream).
 */
export function checkCase(c: GauntletCaseTable, r: GauntletResult): string[] {
	const issues: string[] = []

	// The ABSTAIN contract (#1585): the row's expected outcome is NO coordinate, so the grade inverts —
	// any resolved coordinate fails it. Mutually exclusive with a pinned coordinate; a row carrying both
	// is an authoring bug that must be loud, not a precedence question.
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
			// Case-insensitive, matching the component gate: the corpus is authored from an oracle's rendering, and
			// casing is the gazetteer's business (`resolver_name` is proper-cased canonical, #1014).
			if (c.expect_place_name != null && place.name.toLowerCase() !== c.expect_place_name.toLowerCase()) {
				issues.push(`place name "${place.name}" ≠ "${c.expect_place_name}"`)
			}

			// EXACT, unlike the name: a place id is an opaque key (`wof:1108826319`), not prose.
			if (c.expect_place_id != null && place.placeID !== c.expect_place_id) {
				issues.push(`place id "${place.placeID ?? null}" ≠ "${c.expect_place_id}"`)
			}
		}
	}

	// Parsed ahead of the expect_components loop because its keys take PRECEDENCE there. `undefined` tolerated
	// alongside null: a pre-2026-08-11 regression.db has no such column at all (not that the runner would grade
	// one — the corpus stamp refuses first).
	const renderingContract =
		c.expect_component_renderings != null
			? tryParsingJSON<Record<string, string[]>>(c.expect_component_renderings)
			: null

	if (c.expect_component_renderings != null && !renderingContract) {
		issues.push(`expect_component_renderings is not valid JSON (corrupt regression.db row?)`)
	}

	if (c.expect_components != null) {
		// From our own builder's JSON.stringify, so malformed = a corrupt DB row — surface it as a
		// case issue (loud, per-case) rather than letting a raw SyntaxError kill the whole gate.
		const exp = tryParsingJSON<Record<string, string>>(c.expect_components)

		if (!exp) {
			issues.push(`expect_components is not valid JSON (corrupt regression.db row?)`)
		} else {
			for (const [k, v] of Object.entries(exp)) {
				// Superseded: the rendering contract owns this key outright.
				if (renderingContract && k in renderingContract) continue

				const got = componentOf(r, k)

				if (!componentMatches(got ?? "", v)) {
					issues.push(`${k} "${got}" ≠ "${v}"`)
				}
			}
		}
	}

	if (renderingContract) {
		for (const [k, required] of Object.entries(renderingContract)) {
			// LOUD, like the unknown-key throw above: an empty or non-string-array list would assert nothing while
			// looking asserted. The seed schema refuses these on load, so reaching one here means a row bypassed it.
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
