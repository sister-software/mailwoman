/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { abbreviationDictionary } from "@mailwoman/normalize"
import { haversineKm } from "@mailwoman/spatial"

import { buildGauntletDeps, runOne } from "#eval-harness/gauntlet/harness"
import { type GauntletLayerOptions, layerDepsOptions } from "#eval-harness/gauntlet/regression"

const MIN_MUTABLE_BODY_LENGTH = 5

const INV_EPSILON_KM = 0.001

const DIR_NEAR_KM = 5

const BAND_NEAR_KM = 5

interface Base {
	input: string

	postcode: boolean

	locale: string
}

const BASES: Base[] = [
	{ input: "181 Rue du Chevaleret, Paris", postcode: false, locale: "fr-FR" },
	{ input: "181 Rue du Chevaleret, 75013 Paris", postcode: true, locale: "fr-FR" },
	{ input: "1600 Pennsylvania Ave NW, Washington DC", postcode: false, locale: "en-US" },
	{ input: "1600 Pennsylvania Ave NW, Washington DC 20500", postcode: true, locale: "en-US" },
	{ input: "350 5th Ave, New York, NY", postcode: false, locale: "en-US" },
	{ input: "Unter den Linden 77, 10117 Berlin", postcode: true, locale: "de-DE" },
	{ input: "Damrak 1, 1012 LG Amsterdam", postcode: false, locale: "nl-NL" },

	{ input: "350 Fifth Avenue, New York, NY", postcode: false, locale: "en-US" },
	{ input: "100 Centre Street, New York, NY", postcode: false, locale: "en-US" },
	{ input: "2 Boulevard du Palais, 75001 Paris", postcode: false, locale: "fr-FR" },
]

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

function longestAlphaToken(s: string): { start: number; body: string } | null {
	let best: { start: number; body: string } | null = null
	const re = /\p{L}+/gu
	let m: RegExpExecArray | null

	while ((m = re.exec(s))) {
		const body = m[0]!

		if (body.length < MIN_MUTABLE_BODY_LENGTH) continue

		if (!best || body.length > best.body.length) {
			best = { start: m.index, body }
		}
	}

	return best
}

function transposeMiddle(s: string): string | null {
	const tok = longestAlphaToken(s)

	if (!tok) return null

	const chars = [...tok.body]
	const mid = Math.floor(chars.length / 2)

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

const INV: Perturbation[] = [
	{ name: "lower", f: (s) => s.toLowerCase() },
	{ name: "upper", f: (s) => s.toUpperCase() },
	{ name: "ws", f: (s) => s.replaceAll(" ", "  ") },
	{ name: "trail-dot", f: (s) => `${s}.` },
	{ name: "comma-tight", f: (s) => s.replaceAll(", ", ",") },

	{ name: "comma-drop", f: (s) => s.replaceAll(",", "") },
	{ name: "abbrev", f: (s, base) => abbreviate(s, base.locale) },
]

const BAND: Perturbation[] = [
	{ name: "transpose", f: (s) => transposeMiddle(s) },
	{ name: "typo-sub", f: (s) => substituteMiddle(s) },
	{ name: "num-ordinal", f: (s) => swapOrdinal(s) },
	{ name: "num-house", f: (s) => spellHouseNumber(s) },
]

const KNOWN_INV_XFAIL = new Map<string, string>()

const KNOWN_BAND_XFAIL = new Map<string, string>()

const dropPostcode = (s: string) =>
	s
		.replace(/\b\d{5}\b/, "")
		.replaceAll(/\s*,\s*,/g, ",")
		.replaceAll(/\s+/g, " ")
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

/**
 * Runs the gauntlet's metamorphic checks over the base addresses and prints a per-perturbation report.
 *
 * It passes only when no invariance, drop-postcode or corruption-band check
 * fails beyond the tracked expected failures.
 */
export async function runMetamorphicLayer(options: GauntletLayerOptions = {}): Promise<{ pass: boolean }> {
	const deps = await buildGauntletDeps(layerDepsOptions(options))

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

		for (const p of INV) {
			const perturbed = p.f(base.input, base)

			if (perturbed == null) continue

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

		for (const p of BAND) {
			const perturbed = p.f(base.input, base)

			if (perturbed == null || perturbed === base.input) continue

			if (canon.lat == null) continue

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

	deps[Symbol.dispose]()

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

			const notes = [t.fails ? `${t.fails} FAIL` : "", t.xfail ? `${t.xfail} xfail` : ""]
				.filter((note) => note.length)
				.join(", ")

			console.log(`  ${set}[${p.name}]`.padEnd(22) + `${heldStr}${notes ? ` (${notes})` : ""}`)
		}
	}

	if (fails.length) {
		console.log(`\nNEW violations (check-failing):`)

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

	const pass = invFails === 0 && dirFails === 0 && bandFails === 0
	const trackedTotal = xfailHit.size + bandXfailHit.size

	console.log(
		`\nverdict: ${pass ? "PASS" : "FAIL"}${pass && trackedTotal ? ` (with ${trackedTotal} tracked xfails)` : ""}`
	)

	return { pass }
}
