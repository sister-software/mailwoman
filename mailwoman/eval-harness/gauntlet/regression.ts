/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Gauntlet regression runner — the gated, curated layer (the executable bug log). Loads `regression.db`,
 *   runs every `status=pass` case through the FULL pipeline, and asserts the ASSEMBLED output: coordinate
 *   within tolerance, resolution tier, and admin components (country/region/locality, case-insensitive). A
 *   fixed bug must STAY fixed — any drift fails the run. This corpus is DELIBERATELY SMALL (curated-set
 *   capture is the Pelias trap); the metamorphic + held-out layers carry breadth.
 *
 *   Run: mailwoman eval gauntlet --layer regression [--candidate <candidate.onnx>]
 */

import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { dataRootPath } from "@mailwoman/core/utils"
import { haversineKm } from "@mailwoman/spatial"

import { buildGauntletDeps, type GauntletResult, runOne } from "./harness.ts"
import type { GauntletDatabase } from "./schema.ts"

/**
 * Candidate-model selection shared by the regression + metamorphic layers.
 *
 * `tokenizer`/`card`: a tokenizer-SPLICE candidate (#444/#884/#912) needs its new vocab paired with the model, or the
 * new embedding rows stay dormant (shipped tokenizer emits no ids for them) and the splice is invisible to the layer.
 * Model-only bumps omit them.
 */
export interface GauntletLayerOptions {
	/** Candidate ONNX. Omit to self-check the shipped default. */
	model?: string
	/** Candidate tokenizer (tokenizer-splice candidates only). */
	tokenizer?: string
	/** Candidate model-card (paired with `tokenizer`). */
	card?: string
	/**
	 * Package-shaped candidate weights dir (`<root>/node_modules/@mailwoman/neural-weights-en-us`). The #718-safe path
	 * for a splice/multisplice candidate — resolves model + tokenizer + card + soft-feed siblings package-shaped, exactly
	 * like `eval parity --weights-cache`. Takes precedence over `model`/`tokenizer`/`card`.
	 */
	weightsCacheRoot?: string
}

const DEFAULT_TOL_M = 5000

/** Map an expect_components key to the assembled-result field it asserts. */
function componentOf(r: GauntletResult, key: string): string | null {
	switch (key) {
		case "country":
			return r.country
		case "region":
			return r.region
		case "locality":
			return r.locality
		default:
			return null
	}
}

/** Run the curated regression layer. Returns `pass` (every `status=pass` case still passes). */
export async function runRegressionLayer(options: GauntletLayerOptions = {}): Promise<{ pass: boolean }> {
	const raw = new DatabaseSync(dataRootPath("gauntlet", "regression.db"), { readOnly: true })
	const kdb = new DatabaseClient<GauntletDatabase>({ database: raw })
	const cases = await kdb.selectFrom("gauntlet_case").selectAll().execute()
	await kdb.destroy()

	/** Assert the assembled result against a case's expectations; returns a list of mismatches (empty = passes). */
	function checkCase(c: (typeof cases)[number], r: GauntletResult): string[] {
		const issues: string[] = []

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

		if (c.expect_components != null) {
			const exp = JSON.parse(c.expect_components) as Record<string, string>

			for (const [k, v] of Object.entries(exp)) {
				const got = componentOf(r, k)

				if ((got ?? "").toLowerCase() !== v.toLowerCase()) {
					issues.push(`${k} "${got}" ≠ "${v}"`)
				}
			}
		}

		return issues
	}

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
	const fails: string[] = [] // status=pass that failed → BLOCK
	const tracked: string[] = [] // known_fail / improvement_target still failing → report, non-blocking
	const newlyPassing: string[] = [] // tracked case that now passes → promote it (anti-rot)
	let gated = 0

	for (const c of cases) {
		const issues = checkCase(c, await runOne(c.input, deps))
		const ref = c.bug_ref ? ` ${c.bug_ref}` : ""

		if (c.status === "pass") {
			gated++

			if (issues.length) {
				fails.push(`  ✗ ${c.id} "${c.input}": ${issues.join("; ")}`)
			}
		} else if (issues.length) {
			tracked.push(`  ~ ${c.id} [${c.status}${ref}]: ${issues.join("; ")}`)
		} else {
			newlyPassing.push(`  + ${c.id} [${c.status}${ref}] now PASSES — promote to status=pass`)
		}
	}
	deps.close()

	console.log(
		`\n=== Gauntlet · regression (${gated - fails.length}/${gated} gated cases pass, ${tracked.length} tracked) ===`
	)

	for (const f of fails) {
		console.log(f)
	}

	if (tracked.length) {
		console.log(`\ntracked (known_fail / improvement_target, non-blocking):`)

		for (const t of tracked) {
			console.log(t)
		}
	}

	if (newlyPassing.length) {
		console.log(`\n⚠ tracked cases that now PASS — promote to status=pass:`)

		for (const p of newlyPassing) {
			console.log(p)
		}
	}
	const pass = fails.length === 0
	console.log(`\nverdict: ${pass ? "PASS" : "FAIL"}`)

	return { pass }
}
