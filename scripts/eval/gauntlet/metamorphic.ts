/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Metamorphic Gauntlet (CheckList INV/DIR) — the un-gameable layer. It asserts RELATIONS between outputs,
 *   not stored expected values, so a curated corpus can't breed false trust here.
 *
 *   - INV (invariance): a label-preserving perturbation (casing, whitespace, trailing punctuation) must NOT
 *       move the assembled coordinate or tier. A drift is a surface-form robustness bug.
 *   - DIR (directional): dropping the postcode must NOT break resolution — the result must still land near
 *       the with-postcode coordinate. This is exactly the #251 failure class, frozen as a standing property.
 *
 *   GATE: any INV violation, or a DIR that fails to resolve near the anchor, fails the run. Run:
 *     node scripts/eval/gauntlet/metamorphic.ts [--model <candidate.onnx>]
 */

import { haversineKm } from "@mailwoman/spatial"

import { arg } from "../../lib/cli-args.ts"
import { buildGauntletDeps, runOne } from "./harness.ts"

const INV_EPSILON_KM = 0.001 // 1m — same address, identical resolution expected.
const DIR_NEAR_KM = 5 // dropping the postcode may lose the rooftop, but must still land in the right area.

/** Base inputs. The postcode'd ones drive the DIR (drop-postcode) test; all drive INV. */
const BASES = [
	{ input: "181 Rue du Chevaleret, Paris", postcode: false },
	{ input: "181 Rue du Chevaleret, 75013 Paris", postcode: true },
	{ input: "1600 Pennsylvania Ave NW, Washington DC", postcode: false },
	{ input: "1600 Pennsylvania Ave NW, Washington DC 20500", postcode: true },
	{ input: "350 5th Ave, New York, NY", postcode: false },
	{ input: "Unter den Linden 77, 10117 Berlin", postcode: true }, // DE rooftop tier (D10)
	{ input: "Damrak 1, 1012 LG Amsterdam", postcode: false }, // NL rooftop tier (D10); NL postcode ≠ \d{5}, so INV-only
]

/** Label-preserving perturbations — the output must be invariant to these. */
const INV = [
	{ name: "lower", f: (s: string) => s.toLowerCase() },
	{ name: "upper", f: (s: string) => s.toUpperCase() },
	{ name: "ws", f: (s: string) => s.replace(/ /g, "  ") },
	{ name: "trail-dot", f: (s: string) => `${s}.` },
	{ name: "comma-tight", f: (s: string) => s.replace(/, /g, ",") }, // surface-form: drop the space after a comma
]

/**
 * Known, DETERMINISTIC INV failures (the pipeline is argmax + SQL — failures don't flap). Each is tracked by
 * an issue and reported as xfail: visible, but NON-blocking, so the gate fails only on NEW regressions. The
 * loop also flags any xfail that has started PASSING ("newly passing → drop it"), so this list can't rot into
 * false comfort — the Pelias-pass-list trap, inverted.
 */
const KNOWN_INV_XFAIL = new Map<string, string>([
	["lower|1600 Pennsylvania Ave NW, Washington DC", "#829 — US lowercase model sensitivity (retrain)"],
	["lower|Damrak 1, 1012 LG Amsterdam", "#829 — lowercase sensitivity, NL: resolution → null (more severe)"],
	// #831 — the no-postcode form of the FR demo address sits on a rooftop/admin boundary: the canonical
	// MISSES rooftop while every surface perturbation HITS it. Likely the same case-sensitive-parse root as
	// #829 (mixed-case canonical parses differently from its lower/upper variants).
	["lower|181 Rue du Chevaleret, Paris", "#831 — FR no-postcode rooftop/admin boundary"],
	["upper|181 Rue du Chevaleret, Paris", "#831 — FR no-postcode rooftop/admin boundary"],
	["trail-dot|181 Rue du Chevaleret, Paris", "#831 — FR no-postcode rooftop/admin boundary"],
	["comma-tight|181 Rue du Chevaleret, Paris", "#831 — FR no-postcode rooftop/admin boundary"],
])

/** Strip a 5-digit (US/FR) postcode token for the DIR test. */
const dropPostcode = (s: string) => s.replace(/\b\d{5}\b/, "").replace(/\s*,\s*,/g, ",").replace(/\s+/g, " ").trim()

const deps = await buildGauntletDeps(arg("model", "") ? { modelPath: arg("model", "") } : {})

let invChecks = 0
let invFails = 0
let dirChecks = 0
let dirFails = 0
const fails: string[] = []
const xfails: string[] = []
const xfailHit = new Set<string>()

for (const base of BASES) {
	const canon = await runOne(base.input, deps)

	// INV: every label-preserving perturbation must reproduce the canonical coordinate + tier.
	for (const p of INV) {
		invChecks++
		const r = await runOne(p.f(base.input), deps)
		const moved =
			r.tier !== canon.tier ||
			(canon.lat != null && r.lat != null && haversineKm(canon.lat, canon.lon!, r.lat, r.lon!) > INV_EPSILON_KM) ||
			(canon.lat == null) !== (r.lat == null)

		if (!moved) continue
		const key = `${p.name}|${base.input}`
		const tracked = KNOWN_INV_XFAIL.get(key)
		const line = `INV[${p.name}] "${base.input}" → tier ${canon.tier}→${r.tier}, coord ${canon.lat},${canon.lon} → ${r.lat},${r.lon}`

		if (tracked) {
			xfailHit.add(key)
			xfails.push(`  ~ ${line}  [xfail: ${tracked}]`)
		} else {
			invFails++
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
			fails.push(`  ✗ DIR[drop-postcode] "${base.input}" → "${dropPostcode(base.input)}" landed ${dropped.lat},${dropped.lon} (anchor ${canon.lat},${canon.lon})`)
		}
	}
}
deps.close()

// Anti-rot: a tracked xfail that did NOT fire has been fixed — surface it so the list can't accrete stale entries.
const newlyPassing = [...KNOWN_INV_XFAIL].filter(([key]) => !xfailHit.has(key))

console.log(`\n=== Gauntlet · metamorphic ===`)
console.log(`  INV (label-preserving invariance): ${invChecks - invFails - xfailHit.size}/${invChecks} held, ${xfailHit.size} known-xfail`)
console.log(`  DIR (drop-postcode still resolves): ${dirChecks - dirFails}/${dirChecks} held`)

if (fails.length) {
	console.log(`\nNEW violations (gate-failing):`)
	for (const f of fails) console.log(f)
}

if (xfails.length) {
	console.log(`\nknown xfails (tracked, non-blocking):`)
	for (const f of xfails) console.log(f)
}

if (newlyPassing.length) {
	console.log(`\n⚠ xfails that now PASS — remove from KNOWN_INV_XFAIL:`)
	for (const [key, issue] of newlyPassing) console.log(`  + ${key}  [was: ${issue}]`)
}
// The gate fails on NEW regressions only. A newly-passing xfail is a bookkeeping nudge, not a failure.
const pass = invFails === 0 && dirFails === 0
console.log(`\nverdict: ${pass ? "PASS" : "FAIL"}${pass && xfailHit.size ? ` (with ${xfailHit.size} tracked xfails)` : ""}`)
process.exit(pass ? 0 : 1)
