/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   External-arenas.ts — run the three UNBIASED capability arenas through harness-v0-neural.
 *
 *   Our own 376-assertion suite is a Pelias/addressit port (v0's lineage), so it can't reveal where
 *   neural earns its keep. These three arenas come from outside that lineage and together map the
 *   v0-vs-neural capability surface:
 *
 *   1. Libpostal — statistical parser's hand-curated adversarial cases (clean, canonical)
 *   2. Perturbation — golden v0.1.2 with rule-defeating transforms (noisy, degraded)
 *   3. Postal-standards — postal-authority example addresses, edge formats by class (military APO/FPO,
 *        PO-box variety, secondary-unit, intl)
 *
 *   All three are scored with --symmetric-match (v0 scored on the same loose subset matcher as neural
 *   — fair to remapped/dropped-tag cases) and --postcode-repair.
 *
 *   Usage (default shipped weights): node --experimental-strip-types scripts/eval/external-arenas.ts
 *   Against a specific model (e.g. a fresh v0.7.2 export): MODEL=/path/model.int8.onnx
 *   TOKENIZER=/path/tokenizer.model\
 *   MODELCARD=/path/model-card.json node --experimental-strip-types scripts/eval/external-arenas.ts
 *
 *   Emits per-arena three-bucket tables (neural-only / both / v0-only / both-fail) and, for the
 *   postal arena, a breakdown by edge_class. Run `yarn compile` first — the harness resolves
 * @mailwoman/neural to its compiled out/ tree.
 */

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { $ } from "zx"

import { runIfScript } from "mailwoman/sdk/scripting"

runIfScript(import.meta, async () => {
	// zx: capture output ourselves (don't echo the full stream) and slice the way the bash `| tail` did.
	$.verbose = false

	const outDir = process.env["OUT_DIR"] ?? "/tmp/external-arenas"
	mkdirSync(outDir, { recursive: true })
	const emptyTests = join(outDir, "empty-tests")
	mkdirSync(emptyTests, { recursive: true })

	// Model args: pass through if MODEL set, else harness uses loadFromWeights() default.
	const modelArgs: string[] = []
	const model = process.env["MODEL"]
	if (model) {
		// Under the bash `set -u`, TOKENIZER + MODELCARD were unbound-variable errors when MODEL was set.
		const tokenizer = process.env["TOKENIZER"]
		const modelCard = process.env["MODELCARD"]
		if (!tokenizer || !modelCard) throw new Error("MODEL is set → TOKENIZER and MODELCARD are required")
		modelArgs.push("--model", model, "--tokenizer", tokenizer, "--model-card", modelCard)
		// Gaz-trained models (v4.2.0+): feed the ship config — zero-filled clues depress country
		// recall and fake an affix crash. Opt in via GAZETTEER=/path/lexicon.json [ANCHOR=/path/lookup.json].
		if (process.env["GAZETTEER"]) modelArgs.push("--gazetteer-lexicon", process.env["GAZETTEER"])
		if (process.env["ANCHOR"]) modelArgs.push("--anchor-lookup", process.env["ANCHOR"])
		// Conventions mask (#511 Tier A): CONVENTIONS=auto for v4.3.0+ ship config.
		if (process.env["CONVENTIONS"]) modelArgs.push("--conventions", process.env["CONVENTIONS"])
		// Span bridge (v4.4.0 corrective): BRIDGE=1 for v4.4.0+ ship config.
		if (process.env["BRIDGE"]) modelArgs.push("--bridge-gaps")
		console.log(`Model: ${model}`)
	} else {
		console.log("Model: (default shipped weights)")
	}

	// 1. (re)generate the perturbation arena from golden v0.1.2.
	console.log("== regenerating perturbation arena ==")
	const perturbed =
		await $`node --experimental-strip-types scripts/eval/perturb-golden.ts --golden data/eval/golden/v0.1.2 --out ${join(outDir, "perturb", "perturbed.jsonl")} --per-file 60`
	if (perturbed.stdout.trim()) console.log(perturbed.stdout.trimEnd())
	if (perturbed.stderr.trim()) console.error(perturbed.stderr.trimEnd())

	// Stage each arena in its own dir (harness loads ALL .jsonl in a --falsehoods dir).
	mkdirSync(join(outDir, "libpostal"), { recursive: true })
	mkdirSync(join(outDir, "postal"), { recursive: true })
	copyFileSync("data/eval/external/libpostal-cases.jsonl", join(outDir, "libpostal", "libpostal-cases.jsonl"))
	copyFileSync("data/eval/external/postal-cases.jsonl", join(outDir, "postal", "postal-cases.jsonl"))

	// Harness writes its progress to <name>.stderr; we tail the last 40 summary lines off stdout.
	const runArena = async (name: string, dir: string): Promise<void> => {
		console.log(`== arena: ${name} ==`)
		const r =
			await $`node --experimental-strip-types scripts/harness-v0-neural.ts --tests ${emptyTests} --falsehoods ${dir} ${modelArgs} --postcode-repair --symmetric-match --out-json ${join(outDir, `${name}.results.json`)}`
		writeFileSync(join(outDir, `${name}.stderr`), r.stderr)
		console.log(r.stdout.split("\n").slice(-40).join("\n"))
	}

	await runArena("libpostal", join(outDir, "libpostal"))
	await runArena("perturb", join(outDir, "perturb"))
	await runArena("postal", join(outDir, "postal"))

	console.log("")
	console.log("== three-bucket summary + postal edge-class breakdown ==")
	const summary =
		await $`node --experimental-strip-types scripts/eval/summarize-arenas.ts ${outDir} data/eval/external/postal-cases.jsonl`
	console.log(summary.stdout.trimEnd())
	if (summary.stderr.trim()) console.error(summary.stderr.trimEnd())
})
