/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   THE Gauntlet gate — runs all three layers and emits one combined verdict, so a model ship gates on the
 *   full-pipeline integration net, not just per-tag F1 (the whole point of building it; #566 lesson):
 *
 *     1. regression  — the curated executable bug log; a fixed bug must STAY fixed (gated on status=pass).
 *     2. metamorphic — un-gameable INV/DIR relations; surface-form robustness (gated minus tracked xfails).
 *     3. held-out    — candidate-vs-prod z-test on a fresh draw; THE generalization gate (only with --candidate).
 *
 *   Self-check (shipped default):  mailwoman eval gauntlet
 *   Promote gate (a candidate):    mailwoman eval gauntlet --candidate ./out/v195/model.onnx [--source us]
 *   One layer only:                mailwoman eval gauntlet --layer regression|metamorphic|holdout …
 *
 *   The retired `scripts/eval/gauntlet/run.ts` ran each layer in its own child process; the layers are
 *   in-process modules now — a layer that THROWS is caught, printed, and counted as a FAIL, preserving the
 *   old isolated-failure semantics without the spawn.
 *
 *   Wire into the release flow as a `before:release` gate (RELEASING.md): a non-zero exit blocks the ship.
 */

import { runHoldoutLayer } from "./holdout.ts"
import { runMetamorphicLayer } from "./metamorphic.ts"
import { type GauntletLayerOptions, runRegressionLayer } from "./regression.ts"

/** The three Gauntlet layers. */
export type GauntletLayer = "regression" | "metamorphic" | "holdout"

/** Options for {@linkcode runGauntlet}. */
export interface GauntletRunOptions {
	/** Candidate ONNX. Omit for the shipped-default self-check (regression + metamorphic only). */
	candidate?: string
	/** Held-out truth source (`fr` | `us`). Default `fr`. */
	source?: string
	/**
	 * A tokenizer-SPLICE candidate (#444/#884/#912) ships a new vocab — forward it so the held-out layer pairs the
	 * candidate model with the candidate tokenizer (and runs production through the shipped trio).
	 */
	tokenizer?: string
	/** Candidate model-card (paired with `tokenizer`). */
	card?: string
	/** Run ONE layer instead of the combined gate. */
	layer?: GauntletLayer
	/** Held-out fresh-draw sample size. Default 300. */
	n?: number
}

/** Run a single layer, mapping its result to an exit code. A throw prints and reads as exit 1. */
async function runLayer(layer: GauntletLayer, options: GauntletRunOptions): Promise<number> {
	const layerOptions: GauntletLayerOptions = {
		model: options.candidate,
		tokenizer: options.tokenizer,
		card: options.card,
	}

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
				})
			).exitCode
	}
}

/**
 * Run the Gauntlet. With `layer` set, runs that single layer and returns its exit code verbatim; otherwise runs the
 * combined gate (regression + metamorphic, plus held-out when a candidate is given) and returns 0 only when every layer
 * passes.
 */
export async function runGauntlet(options: GauntletRunOptions = {}): Promise<{ exitCode: number }> {
	if (options.layer) {
		return { exitCode: await runLayer(options.layer, options) }
	}

	const candidate = options.candidate || ""
	const layers: GauntletLayer[] = ["regression", "metamorphic"]

	// The held-out layer is candidate-vs-prod — it only runs when a candidate model is supplied.
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
			// The old runner spawned each layer, so a crash was an isolated non-zero exit. Preserve that:
			// print the failure and count the layer as FAIL rather than aborting the combined verdict.
			console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
			results.push({ name: layer === "holdout" ? "held-out" : layer, pass: false })
		}
	}

	const allPass = results.every((r) => r.pass)

	console.log(`\n════════════════ GAUNTLET ════════════════`)

	for (const r of results) {
		console.log(`  ${r.pass ? "✓ PASS" : "✗ FAIL"}  ${r.name}`)
	}
	console.log(`\nVERDICT: ${allPass ? "PASS — clear to ship" : "FAIL — do not ship"}`)

	return { exitCode: allPass ? 0 : 1 }
}
