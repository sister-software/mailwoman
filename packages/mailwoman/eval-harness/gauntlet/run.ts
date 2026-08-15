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
 *   A RESOLVER lever, both ways:   mailwoman eval gauntlet [--postcode-country-coherence]
 *   The load-bearing MAP:          mailwoman eval gauntlet --layer ablation [--components postcode,street]
 *
 *   That last one is not a gate. `ablation` (2026-08-05) deletes each asserted component from each corpus row and
 *   measures what the deletion costs, per (component, locale) — the operator's "where does the pipeline falter when a
 *   part of the address is missing?" It is reachable only via `--layer` and is deliberately absent from the combined
 *   verdict below: its expectations are DERIVED from the gazetteer at run time rather than stored, and a measurement
 *   that could fail a ship would invite tuning the corpus instead of the parser.
 *
 *   Derived, not absent: a variant is graded against the row's degradation ladder (`ablation-expectation.ts`), so
 *   "correctly coarsened" and "abstained under untenable ambiguity" are PASSES and only the real defects are red.
 *
 *   The last of those is the resolver-lever pin (#42, added 2026-08-05). The gate could swap the MODEL under test but
 *   not the resolver configuration, so a resolver lever proposed for default-on had no way through the D-rule's
 *   standard instrument — it could only be argued from bespoke probes. Run the gate unpinned and pinned and diff the
 *   verdicts; the layers stamp which configuration they graded, and the regression layer reports how many cases the
 *   lever actually fired on (an unchanged verdict from a mechanism that never ran proves nothing).
 *
 *   The retired `scripts/eval/gauntlet/run.ts` ran each layer in its own child process; the layers are
 *   in-process modules now — a layer that THROWS is caught, printed, and counted as a FAIL, preserving the
 *   old isolated-failure semantics without the spawn.
 *
 *   Wire into the release flow as a `before:release` gate (RELEASING.md): a non-zero exit blocks the ship.
 */

import { type AblationLayerOptions, runAblationLayer } from "./ablation.ts"
import { describeResolverLevers, type GauntletResolverLevers } from "./harness.ts"
import { runHoldoutLayer } from "./holdout.ts"
import { runMetamorphicLayer } from "./metamorphic.ts"
import { type GauntletLayerOptions, runRegressionLayer } from "./regression.ts"

/**
 * The Gauntlet layers. The first three are GATES and make up the combined verdict; `ablation` is a MEASUREMENT layer —
 * reachable only via `--layer ablation`, deliberately absent from the combined gate below, and incapable of blocking a
 * ship. It produces the load-bearing map (what deleting each component costs, per locale), which is a question about
 * the corpus and the resolver rather than a pass/fail about a candidate.
 */
export type GauntletLayer = "regression" | "metamorphic" | "holdout" | "ablation"

/**
 * Options for {@linkcode runGauntlet}.
 */
export interface GauntletRunOptions {
	/**
	 * Candidate ONNX. Omit for the shipped-default self-check (regression + metamorphic only).
	 */
	candidate?: string
	/**
	 * Held-out truth source (`fr` | `us`). Default `fr`.
	 */
	source?: string
	/**
	 * A tokenizer-SPLICE candidate (#444/#884/#912) ships a new vocab — forward it so the held-out layer pairs the
	 * candidate model with the candidate tokenizer (and runs production through the shipped trio).
	 */
	tokenizer?: string
	/**
	 * Candidate model-card (paired with `tokenizer`).
	 */
	card?: string
	/**
	 * Package-shaped candidate weights dir (`<root>/node_modules/@mailwoman/neural-weights-en-us`) — the #718-safe path
	 * for a splice/multisplice candidate; mirrors `eval parity --weights-cache`. Takes precedence over
	 * `candidate`/`tokenizer`.
	 */
	weightsCacheRoot?: string
	/**
	 * Run ONE layer instead of the combined gate.
	 */
	layer?: GauntletLayer
	/**
	 * Held-out fresh-draw sample size. Default 300.
	 */
	n?: number
	/**
	 * RESOLVER-side lever pin (#42): force `postcodeCountryCoherence` ON or OFF for every layer. `undefined` grades the
	 * shipped configuration, which since the 2026-08-05 promotion is ON — so the pin that carries evidence now is the OFF
	 * one. Run the gate BOTH ways and diff the verdicts, which is what the D-rule asks of a default-on mechanism.
	 */
	postcodeCountryCoherence?: boolean
	/**
	 * RESOLVER-side lever pin (#1497): feed the gazetteer FST prior to the parse. One-sided — the prior is OFF on this
	 * path today, so there is no production default to preserve and `undefined` means the incumbent behaviour.
	 */
	gazetteerPrior?: boolean
	/**
	 * Ablation: where the map artifacts land. Defaults to `/tmp/ablation-<YYYYMMDD-HHmm>`.
	 */
	out?: string
	/**
	 * Ablation: restrict which components get deleted (default: all of `ABLATABLE_COMPONENTS`).
	 */
	components?: readonly string[]
	/**
	 * Ablation: cap the number of CASES (not variants) — a smoke run.
	 */
	limit?: number
}

/**
 * The ablation layer's options: the shared model/lever ladder plus its own three. Exported and pure for the same reason
 * as {@linkcode runResolverLevers} — a dropped `--components` filter would silently run the whole corpus.
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
 * The resolver-lever pins a run's options describe, or undefined when nothing is pinned (→ production defaults). Pure
 * and exported: the "a pin reaches every layer" contract is a mapping, and a mapping is cheap to test — the alternative
 * is discovering a dropped pin from two identical gate logs, which is the failure this whole surface exists to
 * prevent.
 */
export function runResolverLevers(options: GauntletRunOptions): GauntletResolverLevers | undefined {
	const levers: GauntletResolverLevers = {
		...(options.postcodeCountryCoherence === undefined
			? {}
			: { postcodeCountryCoherence: options.postcodeCountryCoherence }),
		...(options.gazetteerPrior ? { gazetteerPrior: true } : {}),
	}

	// Absent, not empty: `undefined` is what `describeResolverLevers` prints as "production defaults", and an empty
	// object would read as "pinned to nothing".
	return Object.keys(levers).length ? levers : undefined
}

/**
 * The layer options a run's options describe — model selection plus the resolver lever pins. Exported for the same
 * reason as {@linkcode runResolverLevers}.
 */
export function runLayerOptions(options: GauntletRunOptions): GauntletLayerOptions {
	const levers = runResolverLevers(options)

	return {
		model: options.candidate,
		tokenizer: options.tokenizer,
		card: options.card,
		weightsCacheRoot: options.weightsCacheRoot,
		...(levers ? { levers } : {}),
	}
}

/**
 * Run a single layer, mapping its result to an exit code. A throw prints and reads as exit 1.
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
					...(layerOptions.levers ? { levers: layerOptions.levers } : {}),
				})
			).exitCode
		case "ablation":
			// Exit 0 unless the instrument produced NO cell. The map grades the corpus + resolver, not a candidate,
			// so it can never block a ship — see the `GauntletLayer` docstring.
			return (await runAblationLayer(runAblationOptions(options))).pass ? 0 : 1
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

	const candidate = options.candidate || options.weightsCacheRoot || ""
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
	// The lever line prints on EVERY run, pinned or not. Two gate logs that differ only in a flag someone typed are
	// not evidence about that flag unless each log says which configuration it graded.
	console.log(`  ${describeResolverLevers(runResolverLevers(options))}`)

	for (const r of results) {
		console.log(`  ${r.pass ? "✓ PASS" : "✗ FAIL"}  ${r.name}`)
	}

	console.log(`\nVERDICT: ${allPass ? "PASS — clear to ship" : "FAIL — do not ship"}`)

	return { exitCode: allPass ? 0 : 1 }
}
