/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   External-arenas.ts — run the three UNBIASED capability arenas through harness-neural.
 *
 *   Our own 376-assertion suite is a Pelias/addressit port (the retired rules parser's lineage), so
 *   it over-represents that lineage's cases. These three arenas come from outside it and together
 *   map the capability surface (formerly v0-vs-neural; the v7 excision #1151 deleted the rules arm,
 *   so the arenas now grade neural alone — pass rates stay comparable, the harness's neural
 *   semantics are unchanged):
 *
 *   1. Libpostal — statistical parser's hand-curated adversarial cases (clean, canonical)
 *   2. Perturbation — golden v0.1.2 with rule-defeating transforms (noisy, degraded)
 *   3. Postal-standards — postal-authority example addresses, edge formats by class (military APO/FPO,
 *        PO-box variety, secondary-unit, intl)
 *
 *   All three are scored with --postcode-repair.
 *
 *   Usage (default shipped weights): node scripts/eval/external-arenas.ts
 *   Against a specific model (e.g. a fresh v0.7.2 export): MODEL=/path/model.int8.onnx
 *   TOKENIZER=/path/tokenizer.model\
 *   MODELCARD=/path/model-card.json node scripts/eval/external-arenas.ts
 *
 *   Emits per-arena three-bucket tables (neural-only / both / v0-only / both-fail) and, for the
 *   postal arena, a breakdown by edge_class. Run `yarn compile` first — the harness resolves
 * @mailwoman/neural to its compiled out/ tree.
 *
 *   The promotion gate calls {@linkcode externalArenas} IN-PROCESS (when the spec floors
 *   `arena.perturb`) and captures `${report}${reportError}` into `<out-dir>/arenas.md` — the file
 *   the verdict assembler column-reads for `arena.perturb`. A THROW here is what the child's
 *   non-zero exit was, and the gate aborts on it exactly as before.
 *
 *   SCOPE NOTE (de-shell): the three inner probes this still spawns as child processes —
 *   `perturb-golden.ts`, `harness-neural.ts` (×3) and `summarize-arenas.ts` — are `scripts/eval`
 *   residents, not gate legs, and de-shelling them is a separate job. `zx` therefore survives HERE
 *   while it is gone from `promotion-gate.ts`.
 */

import { tempRootPath } from "@mailwoman/core/data-root"
import { writeLocalFile, copyFileTo, makeDirectories } from "@mailwoman/core/fs/writers"
import { join } from "path-ts"
import { TextSpliterator } from "spliterator"
import { $ } from "zx"

/**
 * Options for {@linkcode externalArenas} — one field per flag the gate used to serialize into argv.
 */
export interface ExternalArenasOptions {
	/**
	 * Where the staged arenas and their result JSON land. Default `/tmp/external-arenas`.
	 */
	outDir?: string
	/**
	 * Candidate ONNX. Omit to grade the default shipped weights. When set, {@linkcode ExternalArenasOptions.tokenizer} and
	 * {@linkcode ExternalArenasOptions.modelCard} become REQUIRED.
	 */
	model?: string
	tokenizer?: string
	modelCard?: string
	/**
	 * Gaz-trained models (v4.2.0+): feed the ship config — zero-filled clues depress country recall and fake an affix
	 * crash.
	 */
	gazetteerLexicon?: string
	anchorLookup?: string
	/**
	 * Conventions mask (#511 Tier A): `auto` for v4.3.0+ ship config.
	 */
	conventions?: string
	/**
	 * Span bridge (v4.4.0 corrective).
	 */
	bridgeGaps?: boolean
}

/**
 * Run the three unbiased capability arenas. Narration splits across `report`/`reportError` the way the child process's
 * stdout/stderr did, because the gate concatenates them in that order into `arenas.md`.
 *
 * THROWS on a failed inner probe — the in-process spelling of the non-zero exit the gate treats as fatal.
 */
export async function externalArenas(
	options: ExternalArenasOptions = {},
	report: (line: string) => void = console.log,
	reportError: (line: string) => void = console.error
): Promise<void> {
	// zx: capture output ourselves (don't echo the full stream) and slice the way the bash `| tail` did.
	$.verbose = false

	const outDir = options.outDir ?? tempRootPath("external-arenas")
	await makeDirectories(outDir)
	const emptyTests = join(outDir, "empty-tests")
	await makeDirectories(emptyTests)

	// Model args: pass through if a model is set, else the harness uses its loadFromWeights() default.
	const modelArgs: string[] = []
	const model = options.model

	if (model) {
		const tokenizer = options.tokenizer
		const modelCard = options.modelCard

		if (!tokenizer || !modelCard) throw new Error("model is set → tokenizer and modelCard are required")
		modelArgs.push("--model", model, "--tokenizer", tokenizer, "--model-card", modelCard)

		if (options.gazetteerLexicon) {
			modelArgs.push("--gazetteer-lexicon", options.gazetteerLexicon)
		}

		if (options.anchorLookup) {
			modelArgs.push("--anchor-lookup", options.anchorLookup)
		}

		if (options.conventions) {
			modelArgs.push("--conventions", options.conventions)
		}

		if (options.bridgeGaps) {
			modelArgs.push("--bridge-gaps")
		}

		report(`Model: ${model}`)
	} else {
		report("Model: (default shipped weights)")
	}

	// 1. (re)generate the perturbation arena from golden v0.1.2.
	report("== regenerating perturbation arena ==")

	const perturbed =
		await $`node scripts/eval/perturb-golden.ts --golden data/eval/golden/v0.1.2 --out ${join(outDir, "perturb", "perturbed.jsonl")} --per-file 60`

	if (perturbed.stdout.trim()) {
		report(perturbed.stdout.trimEnd())
	}

	if (perturbed.stderr.trim()) {
		reportError(perturbed.stderr.trimEnd())
	}

	// Stage each arena in its own dir (harness loads ALL .jsonl in a --falsehoods dir).
	await makeDirectories(join(outDir, "libpostal"))
	await makeDirectories(join(outDir, "postal"))
	await copyFileTo("data/eval/external/libpostal-cases.jsonl", join(outDir, "libpostal", "libpostal-cases.jsonl"))
	await copyFileTo("data/eval/external/postal-cases.jsonl", join(outDir, "postal", "postal-cases.jsonl"))

	// Harness writes its progress to <name>.stderr; we tail the last 40 summary lines off stdout.
	const runArena = async (name: string, dir: string): Promise<void> => {
		report(`== arena: ${name} ==`)

		const r =
			await $`node scripts/eval/harness-neural.ts --tests ${emptyTests} --falsehoods ${dir} ${modelArgs} --postcode-repair --out-json ${join(outDir, `${name}.results.json`)}`

		await writeLocalFile(r.stderr, join(outDir, `${name}.stderr`))

		report([...TextSpliterator.from(r.stdout)].slice(-40).join("\n"))
	}

	await runArena("libpostal", join(outDir, "libpostal"))
	await runArena("perturb", join(outDir, "perturb"))
	await runArena("postal", join(outDir, "postal"))

	report("")
	report("== arena summary + postal edge-class breakdown ==")

	const summary = await $`node scripts/eval/summarize-arenas.ts ${outDir} data/eval/external/postal-cases.jsonl`

	report(summary.stdout.trimEnd())

	if (summary.stderr.trim()) {
		reportError(summary.stderr.trimEnd())
	}
}
