/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Gauntlet eval — runs all three layers and emits one combined verdict, so a model ship checks on the
 *   full-pipeline integration net rather than just per-tag F1:
 *
 *     1. regression  — the curated executable bug log. A fixed bug must stay fixed (conditioned on status=pass).
 *     2. metamorphic — un-gameable INV/DIR relations. Surface-form robustness (conditional minus tracked xfails).
 *     3. held-out    — candidate-vs-prod z-test on a fresh draw. The generalization check (only with --candidate).
 *
 *   `ablation` is a measurement layer reachable only via `--layer`, deliberately absent from the combined verdict because
 *   its expectations are derived from the gazetteer at run time and a measurement that could fail a ship would invite
 *   tuning the corpus instead of the parser.
 *
 *   A layer that throws is caught, printed, and counted as a failed layer, preserving the old isolated-failure semantics
 *   without a child process.
 *
 *   Wired into the release flow as a `before:release` check, where a non-zero exit blocks the ship.
 */

import type { WeakResolutionReading } from "@mailwoman/core/resolver"

import { type AblationLayerOptions, runAblationLayer } from "#eval-harness/gauntlet/ablation"
import { describeResolverPins, type GauntletResolverPins } from "#eval-harness/gauntlet/harness"
import { runHoldoutLayer } from "#eval-harness/gauntlet/holdout"
import { runMetamorphicLayer } from "#eval-harness/gauntlet/metamorphic"
import { type GauntletLayerOptions, runRegressionLayer } from "#eval-harness/gauntlet/regression"

/**
 * The Gauntlet layers; the first three are checks that make up the combined verdict,
 * while `ablation` is a measurement layer reachable only via `--layer ablation`,
 * absent from the combined check, and incapable of blocking a ship.
 */
export type GauntletLayer = "regression" | "metamorphic" | "holdout" | "ablation"

/**
 * Options for {@linkcode runGauntlet}.
 */
export interface GauntletRunOptions {
	/**
	 * Candidate ONNX; omit for the shipped-default self-check (regression + metamorphic only).
	 */
	candidate?: string
	/**
	 * Held-out truth source (`fr` | `us`); default `fr`.
	 */
	source?: string
	/**
	 * A tokenizer-splice candidate ships a new vocab; forward it so the held-out layer pairs the
	 * candidate model with the candidate tokenizer and runs production through the shipped trio.
	 */
	tokenizer?: string
	/**
	 * Candidate model-card (paired with `tokenizer`).
	 */
	card?: string
	/**
	 * Package-shaped candidate weights dir (`<root>/node_modules/@mailwoman/neural-weights-en-us`)
	 * for a splice/multisplice candidate, mirroring `eval parity --weights-cache`;
	 * takes precedence over `candidate`/`tokenizer`.
	 */
	weightsCacheRoot?: string
	/**
	 * Run one layer instead of the combined check.
	 */
	layer?: GauntletLayer
	/**
	 * Held-out fresh-draw sample size.
	 *
	 * Default 300.
	 */
	n?: number
	/**
	 * Force `postcodeCountryCoherence` on or off for every layer; `undefined` grades the
	 * shipped configuration, which is on, so the off pin is the one that carries evidence.
	 */
	postcodeCountryCoherence?: boolean
	/**
	 * Feed the gazetteer FST prior to the parse; production-default `undefined` is on, and `false`
	 * withholds it, because forwarding only the truthy half would silently discard the off flag.
	 */
	gazetteerPrior?: boolean
	/**
	 * The admin-containment re-rank; `undefined` grades the production default (off),
	 * `true` is the evidence pin, and `false` pins the default explicitly
	 * so a log labeled off really graded with the re-rank off.
	 */
	adminContainmentRerank?: boolean
	/**
	 * A span-rescore sub-span may drop context but never a word of the name; `undefined` grades
	 * the production default (off), `true` is the evidence pin, and `false` pins the default
	 * explicitly so a log labeled off really graded with the remainder requirement off.
	 */
	spanRescoreRequireContextRemainder?: boolean
	/**
	 * Which reading of a weak resolution lifts the span-rescore brake; three readings exist so there is
	 * no off spelling, and `undefined` is the production default that takes a `placeID` at face value.
	 */
	spanRescoreWeakResolution?: WeakResolutionReading
	/**
	 * Ablation: where the map artifacts land.
	 *
	 * Defaults to `<temp-root>/ablation-<yyyymmdd-HHmm>`, under `$MAILWOMAN_TEMP_ROOT`.
	 */
	out?: string
	/**
	 * Ablation: restrict which components get deleted (default: all of `ABLATABLE_COMPONENTS`).
	 */
	components?: readonly string[]
	/**
	 * Ablation: cap the number of cases (not variants) — a smoke run.
	 */
	limit?: number
}

/**
 * The ablation layer's options — the shared model/pin ladder plus its own three; pure
 * and exported so a dropped `--components` filter cannot silently run the whole corpus.
 */
export function runAblationOptions(options: GauntletRunOptions): AblationLayerOptions {
	return {
		...runLayerOptions(options),
		...(options.out ? { outDir: options.out } : {}),
		...(options.components?.length ? { components: options.components } : {}),
		...(options.limit ? { limit: options.limit } : {}),
	}
}

/**
 * The resolver pins a run's options describe, or undefined when no option is pinned;
 * pure and exported because the pin-reaches-every-layer mapping is cheap to test,
 * and the alternative is discovering a dropped pin from two identical pin logs.
 */
export function runResolverPins(options: GauntletRunOptions): GauntletResolverPins | undefined {
	const pins: GauntletResolverPins = {
		...(options.postcodeCountryCoherence === undefined
			? {}
			: { postcodeCountryCoherence: options.postcodeCountryCoherence }),
		...(options.gazetteerPrior === undefined ? {} : { gazetteerPrior: options.gazetteerPrior }),
		...(options.adminContainmentRerank === undefined ? {} : { adminContainmentRerank: options.adminContainmentRerank }),
		...(options.spanRescoreRequireContextRemainder === undefined
			? {}
			: { spanRescoreRequireContextRemainder: options.spanRescoreRequireContextRemainder }),
		...(options.spanRescoreWeakResolution === undefined
			? {}
			: { spanRescoreWeakResolution: options.spanRescoreWeakResolution }),
	}

	// Absent rather than empty: `undefined` is what `describeResolverPins` prints as
	// "production defaults", and an empty object would read as "pinned to no option".
	return Object.keys(pins).length ? pins : undefined
}

/**
 * The layer options a run's options describe — model selection plus the resolver pins —
 * exported for the same reason as {@linkcode runResolverPins}.
 */
export function runLayerOptions(options: GauntletRunOptions): GauntletLayerOptions {
	const pins = runResolverPins(options)

	return {
		model: options.candidate,
		tokenizer: options.tokenizer,
		card: options.card,
		weightsCacheRoot: options.weightsCacheRoot,
		...(pins ? { pins } : {}),
	}
}

/**
 * Run a single layer, mapping its result to an exit code; a throw prints and reads as exit 1.
 */
async function runLayer(layer: GauntletLayer, options: GauntletRunOptions): Promise<number> {
	const layerOptions = runLayerOptions(options)

	switch (layer) {
		case "regression":
			return (await runRegressionLayer(layerOptions)).pass ? 0 : 1
		case "metamorphic":
			return (await runMetamorphicLayer(layerOptions)).pass ? 0 : 1
		case "holdout":
			return (
				await runHoldoutLayer({
					candidate: options.candidate,
					n: options.n,
					source: options.source,
					tokenizer: options.tokenizer,
					card: options.card,
					weightsCacheRoot: options.weightsCacheRoot,
					...(layerOptions.pins ? { pins: layerOptions.pins } : {}),
				})
			).exitCode
		case "ablation":
			// Exit 0 unless the instrument produced no cell: the map grades the corpus
			// and resolver rather than a candidate, so it can never block a ship.
			return (await runAblationLayer(runAblationOptions(options))).pass ? 0 : 1
	}
}

/**
 * Run the Gauntlet.
 *
 * With `layer` set, runs that single layer and returns its exit code verbatim.
 * Otherwise runs the combined check (regression + metamorphic, plus held-out when a candidate is given)
 * and returns 0 only when every layer passes.
 */
export async function runGauntlet(options: GauntletRunOptions = {}): Promise<{ exitCode: number }> {
	if (options.layer) {
		return { exitCode: await runLayer(options.layer, options) }
	}

	const candidate = options.candidate || options.weightsCacheRoot || ""
	const layers: GauntletLayer[] = ["regression", "metamorphic"]

	// The held-out layer is candidate-vs-prod and runs only when a candidate model is supplied.
	if (candidate) {
		layers.push("holdout")
	} else {
		console.log("[gauntlet] no --candidate → skipping the held-out generalization layer (self-check mode)")
	}

	const results: Array<{ name: string; pass: boolean }> = []

	for (const layer of layers) {
		console.log(`\n━━━━━━━━━━━━━━━━ ${layer === "holdout" ? "held-out" : layer} ━━━━━━━━━━━━━━━━`)

		try {
			results.push({ name: layer === "holdout" ? "held-out" : layer, pass: (await runLayer(layer, options)) === 0 })
		} catch (error) {
			// A crash must stay an isolated non-zero exit: print the failure and count the
			// layer as failed rather than aborting the combined verdict.
			console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))

			results.push({ name: layer === "holdout" ? "held-out" : layer, pass: false })
		}
	}

	const allPass = results.every((r) => r.pass)

	console.log(`\n════════════════ GAUNTLET ════════════════`)
	// The pin line prints on every run, pinned or not, because two pin logs that differ
	// only in a flag someone typed are not evidence about that flag.
	console.log(`  ${describeResolverPins(runResolverPins(options))}`)

	for (const r of results) {
		console.log(`  ${r.pass ? "✓ PASS" : "✗ FAIL"}  ${r.name}`)
	}

	console.log(`\nVERDICT: ${allPass ? "PASS — clear to ship" : "FAIL — do not ship"}`)

	return { exitCode: allPass ? 0 : 1 }
}
