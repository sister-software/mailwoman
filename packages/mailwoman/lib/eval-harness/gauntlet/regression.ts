/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Gauntlet regression runner — the conditional, curated layer (the executable bug log). Loads `regression.db`,
 *   runs every `status=pass` case through the FULL pipeline, and asserts the ASSEMBLED output: coordinate
 *   within tolerance, resolution tier, resolved place identity, and admin components (case-insensitive). A
 *   fixed bug must STAY fixed — any drift fails the run. This corpus is DELIBERATELY SMALL (curated-set
 *   capture is the Pelias trap); the metamorphic + held-out layers carry breadth.
 *
 *   The grading itself lives in `check-case.ts` (pure, unit-tested); the freshness refusal that runs before
 *   any of it lives in `corpus-stamp.ts`.
 *
 *   Run: mailwoman eval gauntlet --layer regression [--candidate <candidate.onnx>]
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import { checkCase } from "#eval-harness/gauntlet/check-case"
import { assertCorpusStampFresh } from "#eval-harness/gauntlet/corpus-stamp"
import {
	buildGauntletDeps,
	type GauntletDepsOptions,
	type GauntletResolverLevers,
	runOne,
} from "#eval-harness/gauntlet/harness"
import { routeCountry } from "#eval-harness/gauntlet/routing"
import type { GauntletDatabase } from "#eval-harness/gauntlet/schema"

/**
 * Candidate-model selection shared by the regression + metamorphic layers.
 *
 * `tokenizer`/`card`: a tokenizer-SPLICE candidate (#444/#884/#912) needs its new vocab paired with the model, or the
 * new embedding rows stay dormant (shipped tokenizer emits no ids for them) and the splice is invisible to the layer.
 * Model-only bumps omit them.
 */
export interface GauntletLayerOptions {
	/**
	 * Candidate ONNX. Omit to self-check the shipped default.
	 */
	model?: string
	/**
	 * Candidate tokenizer (tokenizer-splice candidates only).
	 */
	tokenizer?: string
	/**
	 * Candidate model-card (paired with `tokenizer`).
	 */
	card?: string
	/**
	 * Package-shaped candidate weights dir (`<root>/node_modules/@mailwoman/neural-weights-en-us`). The #718-safe path
	 * for a splice/multisplice candidate — resolves model + tokenizer + card + soft-feed siblings package-shaped, exactly
	 * like `eval parity --weights-cache`. Takes precedence over `model`/`tokenizer`/`card`.
	 */
	weightsCacheRoot?: string
	/**
	 * RESOLVER-side lever pins (#42's `postcodeCountryCoherence` today) — the resolver counterpart to the model swaps
	 * above, so a resolver lever can be graded by the standard eval instead of by a bespoke probe. Omitted → production
	 * defaults.
	 */
	levers?: GauntletResolverLevers
}

/**
 * The {@linkcode buildGauntletDeps} argument a layer's options describe — the model-selection ladder (weights-cache →
 * model[+tokenizer/card] → shipped default) with the resolver lever pins carried alongside. Shared by every layer so a
 * new pin cannot reach one layer and silently miss another: the metamorphic layer had an independently-maintained copy
 * of the ladder, which is exactly the shape that drifts.
 */
export function layerDepsOptions(options: GauntletLayerOptions): GauntletDepsOptions {
	const levers = options.levers ? { levers: options.levers } : {}

	if (options.weightsCacheRoot) return { weightsCacheRoot: options.weightsCacheRoot, ...levers }

	if (options.model) {
		return {
			modelPath: options.model,
			...(options.tokenizer ? { tokenizerPath: options.tokenizer } : {}),
			...(options.card ? { modelCardPath: options.card } : {}),
			...levers,
		}
	}

	return levers
}

/**
 * Run the curated regression layer. Returns `pass` (every `status=pass` case still passes).
 */
export async function runRegressionLayer(options: GauntletLayerOptions = {}): Promise<{ pass: boolean }> {
	using kdb = new DatabaseClient<GauntletDatabase>(dataRootPath("gauntlet", "regression.db"), { readOnly: true })
	// Before a single address is graded: does this DB hold the corpus that is committed RIGHT NOW? A check
	// reading a stale artifact reports a verdict about a corpus nobody has — see corpus-stamp.ts.
	await assertCorpusStampFresh(kdb)
	const cases = await kdb.selectFrom("gauntlet_case").selectAll().execute()

	const deps = await buildGauntletDeps(layerDepsOptions(options))

	const fails: string[] = [] // status=pass that failed → BLOCK
	const tracked: string[] = [] // known_fail / improvement_target still failing → report, non-blocking
	const newlyPassing: string[] = [] // tracked case that now passes → promote it (anti-rot)
	let gated = 0
	// #42 firing receipts. An unchanged verdict means "harmless" only if the mechanism actually ran on some row;
	// otherwise it means "never reached", and the two are indistinguishable without this count.
	const overrides: string[] = []

	for (const c of cases) {
		// caseCountry selects the per-locale weights overlay (GB → en-GB's pair-index) — see harness.ts.
		// A row carrying `locale` runs under THAT locale's overlay instead of the truth country's: a
		// #1585 locale-arm row like `Paris` under `en-US` is an FR row (country=FR pins the truth) whose
		// production route goes through the US register. The region subtag is the overlay key.
		const overlayCountry = routeCountry(c)

		const geoOpts = {
			...(c.default_country ? { defaultCountry: c.default_country } : {}),
			...(overlayCountry ? { caseCountry: overlayCountry } : {}),
			// #1585: a locale row's hint scopes the typo-fuzzy tier, mirroring the CLI's unconditional
			// threading of the locale-derived country.
			...(c.locale ? { fuzzyCountryScope: c.locale.split("-")[1] } : {}),
		}

		const result = await runOne(c.input, deps, geoOpts)

		if (result.postcode_country_scope) {
			overrides.push(
				`  · ${c.id} "${c.input}" → country scoped to ${result.postcode_country_scope} (case default ${c.default_country ?? "none"})`
			)
		}

		const issues = checkCase(c, result)
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

	deps[Symbol.dispose]()

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

	// Printed whenever the pass could have fired — i.e. unless it is explicitly pinned OFF. Keying this on the ON
	// PIN was right while the library default was OFF and wrong the moment it flipped (2026-08-05): the standard
	// unpinned run is now the ON configuration and the run whose firing count a reader needs.
	if (options.levers?.postcodeCountryCoherence !== false) {
		console.log(`\npostcode-country coherence fired on ${overrides.length}/${cases.length} cases:`)

		for (const o of overrides) {
			console.log(o)
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
