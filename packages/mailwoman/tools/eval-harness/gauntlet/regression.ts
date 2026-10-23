/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Gauntlet regression runner for the conditional curated layer, the executable bug log. It loads
 *   `regression.db`, runs every `status=pass` case through the full pipeline and checks the assembled
 *   output: coordinate within tolerance, resolution tier, resolved place identity and
 *   admin components (case-insensitive). A fixed bug must stay fixed. Any drift fails the run.
 *   This corpus is deliberately small because curated-set capture is the Pelias trap. The
 *   metamorphic and held-out layers provide breadth.
 *
 *   The grading itself lives in `check-case.ts` (pure, unit-tested), and the freshness refusal
 *   that runs before any of it lives in `corpus-stamp.ts`.
 *
 *   After the tracked list, the report lists the coordinate failures whose expected admin component the
 *   candidate table holds only outside the band its tag selects (#2802). Such a row's coordinate cannot
 *   arrive through that component under any parse, so the line states a data condition beside the grade.
 *   The grade itself does not change: the coordinate can still arrive through another component, and
 *   whether a parent point satisfies the row is a question only the grade answers. Reachability is read
 *   from `reachability.ts` against the candidate table the run resolves against, so a gazetteer rebuild
 *   moves a row off the list on its own.
 *
 *   Run: mailwoman eval gauntlet --layer regression [--candidate <candidate.onnx>]
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { tryParsingJSON } from "@mailwoman/core/json"
import { isPresent } from "@mailwoman/core/objects"
import type { CandidateDatabase } from "@mailwoman/resolver-wof-sqlite/candidate/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import { GEOCODE_SWITCH_DEFAULTS } from "#geocode/core"
import { resolveCandidateDBPath } from "#resolver-backend"
import { checkCase, isCoordinateIssue } from "#tools/eval-harness/gauntlet/check-case"
import { assertCorpusStampFresh } from "#tools/eval-harness/gauntlet/corpus-stamp"
import {
	buildGauntletDeps,
	type GauntletDepsOptions,
	type GauntletResolverPins,
	PRODUCTION_RESOLVER_PINS,
	runOne,
} from "#tools/eval-harness/gauntlet/harness"
import {
	candidateBandProbe,
	describeComponentReachability,
	readExpectationReachability,
} from "#tools/eval-harness/gauntlet/reachability"
import { routeCountry } from "#tools/eval-harness/gauntlet/routing"
import type { GauntletDatabase } from "#tools/eval-harness/gauntlet/schema"
import { pinnedSwitch } from "#tools/eval-harness/switch-pin"

/**
 * Candidate-model selection shared by the regression + metamorphic layers.
 *
 * `tokenizer`/`card`: a tokenizer-splice candidate needs its new vocab paired with the model,
 * since otherwise the new embedding rows stay dormant (the shipped tokenizer emits no ids for them)
 * and the splice is invisible to the layer.
 * Model-only bumps omit them.
 */
export interface GauntletLayerOptions {
	/**
	 * Candidate ONNX.
	 *
	 * Omit to self-check the shipped default.
	 */
	model?: string
	/**
	 * The near-postcode gazetteer choreography, `"declared"` (the card's) by default.
	 *
	 * Any other value is a declared ablation.
	 * The choreography pairs with the train-time half, so a board run under `"off"`
	 * measures the channel's effect on every tag at once.
	 *
	 * This is the only way to count the locality rows it recovers against the
	 * postcode rows it was added to guard.
	 */
	suppressGazetteerNearPostcode?: GauntletDepsOptions["suppressGazetteerNearPostcode"]
	/**
	 * Candidate tokenizer (tokenizer-splice candidates only).
	 */
	tokenizer?: string
	/**
	 * Candidate model-card (paired with `tokenizer`).
	 */
	card?: string
	/**
	 * Package-shaped candidate weights dir (`<root>/node_modules/@mailwoman/neural-weights-en-us`).
	 *
	 * The path for a splice/multisplice candidate.
	 * It resolves the model, tokenizer, card and soft-feed siblings package-shaped,
	 * exactly like `eval parity --weights-cache`.
	 * It takes precedence over `model`/`tokenizer`/`card`.
	 */
	weightsCacheRoot?: string
	/**
	 * Resolver-side pins (`postcodeCountryCoherence` today).
	 *
	 * The resolver counterpart to the model swaps above, so a resolver pin can be graded by the standard eval.
	 *
	 * Omitted → production defaults.
	 */
	pins?: GauntletResolverPins
}

/**
 * The {@linkcode buildGauntletDeps} argument a layer's options describe, the model-selection ladder
 * (weights-cache → model[+tokenizer/card] → shipped default) with the resolver pins listed alongside.
 *
 * Shared by every layer so a new pin cannot reach one layer and silently miss another.
 */
export function layerDepsOptions(options: GauntletLayerOptions): GauntletDepsOptions {
	const pins = {
		...(options.pins ? { pins: options.pins } : {}),
		// Unset leaves `buildGauntletDeps` its one default, the card's declaration.
		...(options.suppressGazetteerNearPostcode
			? { suppressGazetteerNearPostcode: options.suppressGazetteerNearPostcode }
			: {}),
	}

	if (options.weightsCacheRoot) return { weightsCacheRoot: options.weightsCacheRoot, ...pins }

	if (options.model) {
		return {
			modelPath: options.model,
			...(options.tokenizer ? { tokenizerPath: options.tokenizer } : {}),
			...(options.card ? { modelCardPath: options.card } : {}),
			...pins,
		}
	}

	return pins
}

/**
 * Run the curated regression layer.
 *
 * @returns `pass` (every `status=pass` case still passes).
 */
export async function runRegressionLayer(options: GauntletLayerOptions = {}): Promise<{ pass: boolean }> {
	using kdb = new DatabaseClient<GauntletDatabase>(dataRootPath("gauntlet", "regression.db"), { readOnly: true })
	// Before a single address is graded: does this DB hold the corpus that is committed right now?
	// A check reading a stale artifact reports a verdict about a corpus absent from its source data.
	// See corpus-stamp.ts.
	await assertCorpusStampFresh(kdb)
	const cases = await kdb.selectFrom("gauntlet_case").selectAll().execute()

	const deps = await buildGauntletDeps(layerDepsOptions(options))

	// Reachability reads the candidate table the run resolves against, found as `buildGauntletDeps`
	// finds it: `$MAILWOMAN_CANDIDATE_DB`, then the convention path under the data root.
	// A run without one states that the section went unread rather than printing an empty list.
	const candidateDBPath = await resolveCandidateDBPath()

	using candidateDB = candidateDBPath
		? new DatabaseClient<CandidateDatabase>(candidateDBPath, { readOnly: true })
		: null

	const probe = candidateDB ? candidateBandProbe(candidateDB) : null

	const fails: string[] = [] // status=pass that failed → BLOCK
	// Coordinate failures whose expected admin component the table holds only outside its band.
	const unreachable: string[] = []
	const tracked: string[] = [] // known_fail / improvement_target still failing → report, non-blocking
	const newlyPassing: string[] = [] // tracked case that now passes → promote it (anti-rot)
	// Tracked cases that now pass in a locale this run graded base-only.
	// Held back from `newlyPassing` and printed separately, because the pass is
	// not attributable to the production path.
	const withheld: string[] = []
	let counted = 0
	// The receipts record whether the mechanism fired.
	// An unchanged verdict means "harmless" only if the mechanism ran on some row.
	// Otherwise it means "never reached", and the two are indistinguishable without this count.
	const overrides: string[] = []

	for (const c of cases) {
		// caseCountry selects the per-locale weights overlay (GB → en-GB's pair-index).
		// See harness.ts.
		// A row carrying `locale` runs under that locale's overlay: a locale-arm row
		// like `Paris` under `en-US` is an FR row (country=FR pins the truth) whose
		// production route goes through the US register.
		// The region subtag is the overlay key.
		const overlayCountry = routeCountry(c)

		const geoOpts = {
			...(c.default_country ? { defaultCountry: c.default_country } : {}),
			...(overlayCountry ? { caseCountry: overlayCountry } : {}),
			// A locale row's hint scopes the typo-fuzzy tier, mirroring the CLI's
			// unconditional threading of the locale-derived country.
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

		if (probe && c.expect_components && issues.some(isCoordinateIssue)) {
			const expected = tryParsingJSON<Record<string, string>>(c.expect_components)

			const conditions = expected
				? readExpectationReachability(expected, c.country, probe)
						.filter((reading) => reading.state === "unreachable")
						.map((reading) => describeComponentReachability(reading, c.country))
						.filter(isPresent)
				: []

			if (conditions.length) {
				unreachable.push(`  ◦ ${c.id} [${c.status}${ref}] "${c.input}": ${conditions.join("; ")}`)
			}
		}

		if (c.status === "pass") {
			counted++

			if (issues.length) {
				fails.push(`  ✗ ${c.id} "${c.input}": ${issues.join("; ")}`)
			}
		} else if (issues.length) {
			tracked.push(`  ~ ${c.id} [${c.status}${ref}]: ${issues.join("; ")}`)
		} else if (deps.gradedBaseOnly(overlayCountry)) {
			// The overlay this row routes to did not load, so the row graded without
			// its pair index and dependent-locality prior.
			// That is not the production path, so a pass on it is not evidence the production path passes.
			// Promotion would write a base-only result into the board as a regression guard.
			// Reported rather than dropped, since an invisible withholding is
			// indistinguishable from a row that kept failing.
			withheld.push(`  · ${c.id} [${c.status}${ref}] passes, but ${overlayCountry} graded BASE-ONLY — not promotable`)
		} else {
			newlyPassing.push(`  + ${c.id} [${c.status}${ref}] now PASSES — promote to status=pass`)
		}
	}

	deps[Symbol.dispose]()

	console.log(
		`\n=== Gauntlet · regression (${counted - fails.length}/${counted} counted cases pass, ${tracked.length} tracked) ===`
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

	// Printed on every run, so a reader tells "read, none" from "not read".
	// `gauntlet-report.ts` parses both forms.
	if (probe) {
		console.log(
			`\nunreachable by data (${unreachable.length}): coordinate failures whose expected admin component the ` +
				`candidate table holds only outside the band its tag selects`
		)

		for (const u of unreachable) {
			console.log(u)
		}
	} else {
		console.log(
			`\nunreachable by data: NOT READ (no candidate table resolved, so reachability is unknown for every row)`
		)
	}

	// Printed whenever the pass could have fired, except when it is explicitly pinned off.
	// An enabled-pin key would hide the firing count on the standard unpinned run.
	// The pass is now enabled by default.
	if (
		pinnedSwitch(
			(options.pins ?? PRODUCTION_RESOLVER_PINS).postcodeCountryCoherence,
			GEOCODE_SWITCH_DEFAULTS.postcodeCountryCoherence
		)
	) {
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

	if (withheld.length) {
		console.log(
			`\n⚠ ${withheld.length} tracked case(s) pass but are NOT promotable — their locale graded base-only:` +
				`\n  Stage a weights cache carrying every routed overlay, re-run, and read the suggestion from that run.`
		)

		for (const w of withheld) {
			console.log(w)
		}
	}

	const pass = fails.length === 0

	console.log(`\nverdict: ${pass ? "PASS" : "FAIL"}`)

	return { pass }
}
