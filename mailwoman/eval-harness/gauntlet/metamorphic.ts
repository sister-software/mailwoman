/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Metamorphic Gauntlet (CheckList INV/DIR/BAND) — the un-gameable layer. It asserts RELATIONS between
 *   outputs, not stored expected values, so a curated corpus can't breed false trust here.
 *
 *   - INV (invariance, ≤1m): a label-preserving perturbation (casing, whitespace, trailing punctuation,
 *       expanded↔abbreviated suffix) must NOT move the assembled coordinate or tier. A drift is a
 *       surface-form robustness bug. `abbrev` inverts the `normalize/abbreviations.ts` table — the model
 *       trains on both `Avenue` and `Ave`, so the coordinate must not budge.
 *   - DIR (directional, ≤5km): dropping the postcode must NOT break resolution — the result must still
 *       land near the with-postcode coordinate. This is exactly the #251 failure class, frozen as a
 *       standing property.
 *   - BAND (tolerance, ≤5km): a CORRUPTING perturbation (single-char transpose / substitution, ordinal
 *       or house-number spelling) may legitimately shift the parse — byte-identical output is the wrong
 *       contract — but it must still land within a tolerance band of the clean coordinate. Perturbations
 *       the pipeline neither normalizes nor trained on (number-spelling) are EXPECTED to miss the band;
 *       those are recorded in KNOWN_BAND_XFAIL so the gap is documented, non-blocking, and can't be
 *       silently hidden.
 *
 *   GATE: any INV violation, a DIR that fails to resolve near the anchor, or a NEW (untracked) BAND miss
 *   fails the run. Run:
 *     mailwoman eval gauntlet --layer metamorphic [--candidate <candidate.onnx>]
 */

import { abbreviationDictionary } from "@mailwoman/normalize"
import { haversineKm } from "@mailwoman/spatial"

import { buildGauntletDeps, runOne } from "./harness.ts"
import type { GauntletLayerOptions } from "./regression.ts"

const INV_EPSILON_KM = 0.001 // 1m — same address, identical resolution expected.
const DIR_NEAR_KM = 5 // dropping the postcode may lose the rooftop, but must still land in the right area.
const BAND_NEAR_KM = 5 // a corrupted surface may shift the parse, but must stay within the tolerance band.

interface Base {
	input: string
	/** Drives the DIR (drop-postcode) test; all bases drive INV + BAND. */
	postcode: boolean
	/** Selects the abbreviation dictionary for the `abbrev` INV perturbation. */
	locale: string
}

/** Base inputs. The postcode'd ones drive the DIR (drop-postcode) test; all drive INV + BAND. */
const BASES: Base[] = [
	{ input: "181 Rue du Chevaleret, Paris", postcode: false, locale: "fr-FR" },
	{ input: "181 Rue du Chevaleret, 75013 Paris", postcode: true, locale: "fr-FR" },
	{ input: "1600 Pennsylvania Ave NW, Washington DC", postcode: false, locale: "en-US" },
	{ input: "1600 Pennsylvania Ave NW, Washington DC 20500", postcode: true, locale: "en-US" },
	{ input: "350 5th Ave, New York, NY", postcode: false, locale: "en-US" },
	{ input: "Unter den Linden 77, 10117 Berlin", postcode: true, locale: "de-DE" }, // DE rooftop tier (D10)
	{ input: "Damrak 1, 1012 LG Amsterdam", postcode: false, locale: "nl-NL" }, // NL rooftop tier (D10); NL postcode ≠ \d{5}, so INV-only
	// Added for the abbrev + number-spell classes (the original 7 carry no expandable suffix, no ordinal,
	// no spell-able house number). Verified landmark coordinates cited in the design doc; the metamorphic
	// relations are self-referential (perturbed-vs-clean), so the base only needs to resolve sanely.
	{ input: "350 Fifth Avenue, New York, NY", postcode: false, locale: "en-US" }, // Empire State Building (≈40.7484, -73.9857)
	{ input: "100 Centre Street, New York, NY", postcode: false, locale: "en-US" }, // Manhattan Municipal Building (≈40.7132, -74.0041)
	{ input: "2 Boulevard du Palais, 75001 Paris", postcode: false, locale: "fr-FR" }, // Palais de la Cité (≈48.8556, 2.3450)
]

/**
 * Expanded→abbreviated inverse of the shared `normalize/abbreviations.ts` table (imported, never duplicated — "no
 * load-bearing trivia"). Single-letter abbreviations (N/S/E/W/R) are dropped: they're ambiguous with initials, and the
 * invariant tests only unambiguous multi-char suffix swaps. First-wins on ambiguous long forms (FR `Boulevard` maps
 * from both `Bd` and `Bvd` → `Bd`).
 */
function inverseAbbrev(locale: string): Map<string, string> {
	const inv = new Map<string, string>()

	for (const entry of abbreviationDictionary(locale)) {
		if (entry.from.length < 2) continue

		const key = entry.to.toLowerCase()

		if (!inv.has(key)) {
			inv.set(key, entry.from)
		}
	}

	return inv
}

/** Replace the first expandable long-form token with its abbreviation (`Avenue`→`Ave`). Null if none present. */
function abbreviate(input: string, locale: string): string | null {
	const inv = inverseAbbrev(locale)
	const tokens = input.split(/(\s+)/)

	for (let i = 0; i < tokens.length; i++) {
		const bare = tokens[i]!.replace(/[.,]+$/, "")
		const trail = tokens[i]!.slice(bare.length)
		const abbr = inv.get(bare.toLowerCase())

		if (abbr) {
			tokens[i] = abbr + trail

			return tokens.join("")
		}
	}

	return null
}

/** The longest maximal run of letters, length ≥5, leftmost on ties. Null if none — nothing safe to corrupt. */
function longestAlphaToken(s: string): { start: number; body: string } | null {
	let best: { start: number; body: string } | null = null
	const re = /\p{L}+/gu
	let m: RegExpExecArray | null

	while ((m = re.exec(s))) {
		const body = m[0]!

		if (body.length < 5) continue

		if (!best || body.length > best.body.length) {
			best = { start: m.index, body }
		}
	}

	return best
}

/** Adjacent-char swap at the middle of the longest alphabetic token. Deterministic, no RNG. Null if not applicable. */
function transposeMiddle(s: string): string | null {
	const tok = longestAlphaToken(s)

	if (!tok) return null

	const chars = [...tok.body]
	const mid = Math.floor(chars.length / 2) // ≥2 for len ≥5
	// Prefer the pair (mid-1, mid); if those chars are identical the swap is a no-op, so fall to (mid, mid+1).
	let i = mid - 1

	if (chars[i] === chars[i + 1]) {
		if (mid + 1 < chars.length && chars[mid] !== chars[mid + 1]) {
			i = mid
		} else return null
	}
	const swapped = [...chars]
	const tmp = swapped[i]!
	swapped[i] = swapped[i + 1]!
	swapped[i + 1] = tmp

	return s.slice(0, tok.start) + swapped.join("") + s.slice(tok.start + tok.body.length)
}

/** Single-char substitution at the middle of the longest alphabetic token (→`x`, or `z` when already `x`). */
function substituteMiddle(s: string): string | null {
	const tok = longestAlphaToken(s)

	if (!tok) return null

	const chars = [...tok.body]
	const mid = Math.floor(chars.length / 2)
	const orig = chars[mid]!
	const isUpper = orig === orig.toUpperCase() && orig !== orig.toLowerCase()
	const repl = orig.toLowerCase() === "x" ? "z" : "x"
	chars[mid] = isUpper ? repl.toUpperCase() : repl
	const body = chars.join("")

	if (body === tok.body) return null

	return s.slice(0, tok.start) + body + s.slice(tok.start + tok.body.length)
}

/** Numeral↔spelled ordinal street names (`5th`↔`Fifth`). */
const ORDINALS: ReadonlyArray<readonly [string, string]> = [
	["1st", "First"],
	["2nd", "Second"],
	["3rd", "Third"],
	["4th", "Fourth"],
	["5th", "Fifth"],
	["6th", "Sixth"],
	["7th", "Seventh"],
	["8th", "Eighth"],
	["9th", "Ninth"],
	["10th", "Tenth"],
	["11th", "Eleventh"],
	["12th", "Twelfth"],
]

/** Swap the first ordinal-street token between numeral and spelled form (`5th Ave`↔`Fifth Ave`). Null if none. */
function swapOrdinal(s: string): string | null {
	const numToWord = new Map(ORDINALS.map(([n, w]) => [n.toLowerCase(), w]))
	const wordToNum = new Map(ORDINALS.map(([n, w]) => [w.toLowerCase(), n]))
	const tokens = s.split(/(\s+)/)

	for (let i = 0; i < tokens.length; i++) {
		const bare = tokens[i]!.replace(/[.,]+$/, "")
		const trail = tokens[i]!.slice(bare.length)
		const hit = numToWord.get(bare.toLowerCase()) ?? wordToNum.get(bare.toLowerCase())

		if (hit) {
			tokens[i] = hit + trail

			return tokens.join("")
		}
	}

	return null
}

/** Spell out the LEADING house-number token (`100`→`One Hundred`). Bounded map — never a general algorithm. */
const HOUSE_SPELL = new Map<string, string>([["100", "One Hundred"]])

function spellHouseNumber(s: string): string | null {
	const m = /^(\s*)(\d+)\b/.exec(s)

	if (!m) return null

	const spelled = HOUSE_SPELL.get(m[2]!)

	if (!spelled) return null

	return s.slice(0, m[1]!.length) + spelled + s.slice(m[1]!.length + m[2]!.length)
}

interface Perturbation {
	name: string
	f: (s: string, base: Base) => string | null
}

/** Label-preserving perturbations — the output must be INVARIANT (≤1m, same tier). */
const INV: Perturbation[] = [
	{ name: "lower", f: (s) => s.toLowerCase() },
	{ name: "upper", f: (s) => s.toUpperCase() },
	{ name: "ws", f: (s) => s.replace(/ /g, "  ") },
	{ name: "trail-dot", f: (s) => `${s}.` },
	{ name: "comma-tight", f: (s) => s.replace(/, /g, ",") }, // surface-form: drop the space after a comma
	// Delimiter-free invariant (#1101): a whitespace-only address (commas removed, tokens still
	// space-separated) must resolve identically — whitespace-only is 64% of the parity gold. The fix
	// half (punctuation-drop training augmentation) closes any deterministic failure this surfaces; a
	// failing base lands in KNOWN_INV_XFAIL with a #1101 note until then.
	{ name: "comma-drop", f: (s) => s.replace(/,/g, "") },
	{ name: "abbrev", f: (s, base) => abbreviate(s, base.locale) }, // expanded→abbreviated suffix (trained both ways)
]

/** Corrupting perturbations — output may shift, but must stay within the BAND (≤5km). */
const BAND: Perturbation[] = [
	{ name: "transpose", f: (s) => transposeMiddle(s) },
	{ name: "typo-sub", f: (s) => substituteMiddle(s) },
	{ name: "num-ordinal", f: (s) => swapOrdinal(s) },
	{ name: "num-house", f: (s) => spellHouseNumber(s) },
]

/**
 * Known, DETERMINISTIC INV failures (the pipeline is argmax + SQL — failures don't flap). Each is tracked by an issue
 * and reported as xfail: visible, but NON-blocking, so the gate fails only on NEW regressions. The loop also flags any
 * xfail that has started PASSING ("newly passing → drop it"), so this list can't rot into false comfort — the
 * Pelias-pass-list trap, inverted.
 */
// Casing/spacing are fully green (the #829 lowercase restore + trailing-punct trim cleared every prior xfail with no
// retrain). `abbrev` holds for the EN suffix swaps (Avenue→Ave, Street→St) because the model trains on both forms — but
// the FR street-type swap below is a RESOLVER gap, not a model one, and it is a finding, not a reflex xfail (see note).
// A NEW deterministic INV break belongs here with a tracked note, never silently gated.
// The #1002 FR `Boulevard→Bd` xfail was removed 2026-07-06 with its fix: the root cause was NOT the
// FR gazetteer (street_norm expands `bd` fine) but the MODEL absorbing the undertrained "Bd" into
// house_number ("2 Bd") pre-lookup — fixed by enabling Stage-1 `expandAbbreviations` in the geocode
// path with the locale-UNKNOWN safe set (Bd/Bvd/Av/Imp; EN suffixes deliberately untouched). Keep the
// anti-rot loop honest: a NEW deterministic INV break belongs here with a tracked note, never silently gated.
// comma-drop (#1101 delimiter-free invariant): the FR "Rue du Chevaleret" base loses rooftop resolution
// when its comma is stripped (address_point → admin tier, coord → null) — the comma-free parsing gap the
// punctuation-drop training augmentation (#1101) exists to close. Tracked here (visible, non-blocking) until
// that augmentation lands; the anti-rot loop will flag it "newly passing" the moment a retrain fixes it.
const KNOWN_INV_XFAIL = new Map<string, string>([
	// The FR comma-free rooftop loss. Its US twin ("1600 Pennsylvania Ave NW Washington DC") had the SAME
	// #1101 failure on the shipped model (v6.4.0), but the punct-drop augmentation (v3.8.x,
	// augment_punct_drop_prob) FIXES it — it holds on merit — so it is deliberately NOT tracked. The FR base
	// still loses its rooftop after the fix (a resolver dependency beyond the parse), so it stays here.
	["comma-drop|181 Rue du Chevaleret, Paris", "#1101: comma-free FR address loses rooftop (address_point→admin)"],
])

/**
 * Known, DETERMINISTIC BAND misses — the tolerance-band analog of KNOWN_INV_XFAIL, same anti-rot bookkeeping. These are
 * perturbation classes the pipeline neither normalizes nor was trained on, so a corrupted surface legitimately lands
 * outside the band. Tracked (visible, non-blocking) rather than hidden or gated. See the input-robustness coverage
 * matrix (docs/articles/concepts/input-robustness.mdx) for the gaps these pin.
 */
// All measured anchor-OFF/gazetteer-OFF (the harness default; the weights package ships no anchor artifacts). The
// gazetteer soft-feed is exactly the channel that recovers a typo'd locality/street in ship-config, so some of these
// may hold with the retrieval channels ON — tracked here as the anchor-off floor, not a claim about production.
const KNOWN_BAND_XFAIL = new Map<string, string>([
	// House-number spelling is neither normalized nor trained — the expected miss (input-robustness matrix).
	["num-house|100 Centre Street, New York, NY", "untrained: house-number spelling (input-robustness matrix)"],
	// A single-char corruption of a rooftop street token drops the exact match to a ~6.4km fallback (anchor-off).
	["transpose|100 Centre Street, New York, NY", "anchor-off: corrupted street token loses the rooftop (~6.4km)"],
	["typo-sub|100 Centre Street, New York, NY", "anchor-off: corrupted street token loses the rooftop (~6.4km)"],
	// A typo'd NL locality with no \d{5} anchor loses resolution entirely — the case the gazetteer soft-feed exists for.
	["transpose|Damrak 1, 1012 LG Amsterdam", "anchor-off: typo'd locality, no postcode anchor → no-resolve"],
	["typo-sub|Damrak 1, 1012 LG Amsterdam", "anchor-off: typo'd locality, no postcode anchor → no-resolve"],
])

/** Strip a 5-digit (US/FR) postcode token for the DIR test. */
const dropPostcode = (s: string) =>
	s
		.replace(/\b\d{5}\b/, "")
		.replace(/\s*,\s*,/g, ",")
		.replace(/\s+/g, " ")
		.trim()

interface Tally {
	checks: number
	held: number
	fails: number
	xfail: number
}

function bump(m: Map<string, Tally>, name: string, key: keyof Tally): void {
	const t = m.get(name) ?? { checks: 0, held: 0, fails: 0, xfail: 0 }
	t[key] += 1
	m.set(name, t)
}

/** Run the metamorphic layer. Returns `pass` (no NEW INV/DIR/BAND violation beyond the tracked xfails). */
export async function runMetamorphicLayer(options: GauntletLayerOptions = {}): Promise<{ pass: boolean }> {
	const deps = await buildGauntletDeps(
		options.weightsCacheRoot
			? { weightsCacheRoot: options.weightsCacheRoot }
			: options.model
				? {
						modelPath: options.model,
						...(options.tokenizer ? { tokenizerPath: options.tokenizer } : {}),
						...(options.card ? { modelCardPath: options.card } : {}),
					}
				: {}
	)

	const invTally = new Map<string, Tally>()
	const bandTally = new Map<string, Tally>()

	let invChecks = 0
	let invFails = 0
	let dirChecks = 0
	let dirFails = 0
	let bandChecks = 0
	let bandFails = 0
	const fails: string[] = []
	const xfails: string[] = []
	const xfailHit = new Set<string>()
	const bandXfailHit = new Set<string>()

	for (const base of BASES) {
		const canon = await runOne(base.input, deps)

		// INV: every label-preserving perturbation must reproduce the canonical coordinate + tier.
		for (const p of INV) {
			const perturbed = p.f(base.input, base)

			if (perturbed == null) continue // perturbation not applicable to this base (e.g. no expandable suffix)

			invChecks++
			bump(invTally, p.name, "checks")
			const r = await runOne(perturbed, deps)
			const moved =
				r.tier !== canon.tier ||
				(canon.lat != null && r.lat != null && haversineKm(canon.lat, canon.lon!, r.lat, r.lon!) > INV_EPSILON_KM) ||
				(canon.lat == null) !== (r.lat == null)

			if (!moved) {
				bump(invTally, p.name, "held")
				continue
			}
			const key = `${p.name}|${base.input}`
			const tracked = KNOWN_INV_XFAIL.get(key)
			const line = `INV[${p.name}] "${base.input}" → "${perturbed}" · tier ${canon.tier}→${r.tier}, coord ${canon.lat},${canon.lon} → ${r.lat},${r.lon}`

			if (tracked) {
				xfailHit.add(key)
				bump(invTally, p.name, "xfail")
				xfails.push(`  ~ ${line}  [xfail: ${tracked}]`)
			} else {
				invFails++
				bump(invTally, p.name, "fails")
				fails.push(`  ✗ ${line}`)
			}
		}

		// DIR: dropping the postcode must still resolve near the with-postcode anchor.
		if (base.postcode) {
			dirChecks++
			const dropped = await runOne(dropPostcode(base.input), deps)
			const ok =
				dropped.lat != null &&
				canon.lat != null &&
				haversineKm(canon.lat, canon.lon!, dropped.lat, dropped.lon!) <= DIR_NEAR_KM

			if (!ok) {
				dirFails++
				fails.push(
					`  ✗ DIR[drop-postcode] "${base.input}" → "${dropPostcode(base.input)}" landed ${dropped.lat},${dropped.lon} (anchor ${canon.lat},${canon.lon})`
				)
			}
		}

		// BAND: a corrupting perturbation may shift the parse, but must land within the tolerance band.
		for (const p of BAND) {
			const perturbed = p.f(base.input, base)

			if (perturbed == null || perturbed === base.input) continue

			if (canon.lat == null) continue // no clean anchor to measure a band against

			bandChecks++
			bump(bandTally, p.name, "checks")
			const r = await runOne(perturbed, deps)
			const dist = r.lat != null ? haversineKm(canon.lat, canon.lon!, r.lat, r.lon!) : null
			const ok = dist != null && dist <= BAND_NEAR_KM

			if (ok) {
				bump(bandTally, p.name, "held")
				continue
			}
			const key = `${p.name}|${base.input}`
			const tracked = KNOWN_BAND_XFAIL.get(key)
			const movedBy = dist != null ? `${dist.toFixed(1)}km` : "no-resolve"
			const line = `BAND[${p.name}] "${base.input}" → "${perturbed}" · moved ${movedBy} (anchor ${canon.lat},${canon.lon} → ${r.lat},${r.lon})`

			if (tracked) {
				bandXfailHit.add(key)
				bump(bandTally, p.name, "xfail")
				xfails.push(`  ~ ${line}  [xfail: ${tracked}]`)
			} else {
				bandFails++
				bump(bandTally, p.name, "fails")
				fails.push(`  ✗ ${line}`)
			}
		}
	}
	deps.close()

	// Anti-rot: a tracked xfail that did NOT fire has been fixed — surface it so the list can't accrete stale entries.
	const newlyPassing = [
		...[...KNOWN_INV_XFAIL].filter(([key]) => !xfailHit.has(key)),
		...[...KNOWN_BAND_XFAIL].filter(([key]) => !bandXfailHit.has(key)),
	]

	console.log(`\n=== Gauntlet · metamorphic ===`)
	console.log(
		`  INV  (label-preserving, ≤1m):  ${invChecks - invFails - xfailHit.size}/${invChecks} held, ${xfailHit.size} known-xfail`
	)
	console.log(`  DIR  (drop-postcode, ≤5km):    ${dirChecks - dirFails}/${dirChecks} held`)
	console.log(
		`  BAND (corrupting, ≤5km):       ${bandChecks - bandFails - bandXfailHit.size}/${bandChecks} held, ${bandXfailHit.size} known-xfail`
	)

	console.log(`\nper-class:`)

	for (const [set, tally] of [
		["INV", invTally],
		["BAND", bandTally],
	] as const) {
		const order = set === "INV" ? INV : BAND

		for (const p of order) {
			const t = tally.get(p.name)

			if (!t) continue
			const heldStr = `${t.held}/${t.checks} held`
			const notes = [t.fails ? `${t.fails} FAIL` : "", t.xfail ? `${t.xfail} xfail` : ""].filter(Boolean).join(", ")
			console.log(`  ${set}[${p.name}]`.padEnd(22) + `${heldStr}${notes ? ` (${notes})` : ""}`)
		}
	}

	if (fails.length) {
		console.log(`\nNEW violations (gate-failing):`)

		for (const f of fails) {
			console.log(f)
		}
	}

	if (xfails.length) {
		console.log(`\nknown xfails (tracked, non-blocking):`)

		for (const f of xfails) {
			console.log(f)
		}
	}

	if (newlyPassing.length) {
		console.log(`\n⚠ xfails that now PASS — remove from the KNOWN_*_XFAIL map:`)

		for (const [key, issue] of newlyPassing) {
			console.log(`  + ${key}  [was: ${issue}]`)
		}
	}
	// The gate fails on NEW regressions only. A newly-passing xfail is a bookkeeping nudge, not a failure.
	const pass = invFails === 0 && dirFails === 0 && bandFails === 0
	const trackedTotal = xfailHit.size + bandXfailHit.size
	console.log(
		`\nverdict: ${pass ? "PASS" : "FAIL"}${pass && trackedTotal ? ` (with ${trackedTotal} tracked xfails)` : ""}`
	)

	return { pass }
}
