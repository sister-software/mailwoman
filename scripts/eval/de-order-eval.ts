/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Both-order order-robustness eval harness (S6). Runs a model through the resolver on German
 *   addresses in BOTH renderings — native German order (the realistic layout) and US/international
 *   order (the layout our OA de-sample ships) — with the postcode anchor fed and ablated
 *   (oa-resolver-eval's `--anchor-off` → `overrides.anchor=false`, the #718-sanctioned declared
 *   ablation; #887), plus US + FR for the no-regression gate. The German "collapse" was
 *   substantially an eval-order artifact (docs/articles/evals/2026-06-06-anchor-pilot.md); this
 *   makes native-vs-international a first-class, repeatable measurement instead of a one-off.
 *   Self-emits every figure (each run writes its own .md), then prints a 2x2 + US/FR summary. NOTE:
 *   anchor on/off only differs for an anchor-trained (4-input) model; for a plain model both
 *   columns are identical (the anchor inputs are ignored / absent).
 *
 *   Usage: node --experimental-strip-types scripts/eval/de-order-eval.ts\
 *   --model /tmp/v092-eval/model.onnx --card /tmp/v092-eval/model-card.json\
 *   --tokenizer $MAILWOMAN_DATA_ROOT/models/tokenizer/v0.6.0-a0/tokenizer.model\
 *   --anchor-lookup $MAILWOMAN_DATA_ROOT/anchor/pilot-anchor-lookup.json\
 *   --out /tmp/v092-eval
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"

import { dataRootPath } from "@mailwoman/core/utils"
import { runIfScript } from "mailwoman/sdk/scripting"
import { $ } from "zx"

runIfScript(import.meta, async () => {
	$.verbose = false

	let model = ""
	let card = ""
	let tok = dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model")
	let lookup = dataRootPath("anchor", "pilot-anchor-lookup.json")
	let out = "/tmp/order-eval"

	// STRICT parseArgs — the original switch errored on unknown args; parity preserved.
	let cliValues: Record<string, string | boolean | undefined>

	try {
		cliValues = parseArgs({
			options: {
				"anchor-lookup": { type: "string" },
				card: { type: "string" },
				model: { type: "string" },
				out: { type: "string" },
				tokenizer: { type: "string" },
			},
		}).values
	} catch (e) {
		console.error(`unknown arg: ${e instanceof Error ? e.message : e}`)
		process.exit(1)
	}

	if (cliValues["model"] != null) model = cliValues["model"] as string
	if (cliValues["card"] != null) card = cliValues["card"] as string
	if (cliValues["tokenizer"] != null) tok = cliValues["tokenizer"] as string
	if (cliValues["anchor-lookup"] != null) lookup = cliValues["anchor-lookup"] as string
	if (cliValues["out"] != null) out = cliValues["out"] as string

	if (!model || !card) {
		console.error("need --model and --card")
		process.exit(1)
	}

	mkdirSync(out, { recursive: true })
	const deNative = "data/eval/external/openaddresses-de-sample-native-order.jsonl"
	const deIntl = "data/eval/external/openaddresses-de-sample.jsonl"

	// run <eval-jsonl> <anchor-on> <default-country> <out-name>
	const run = async (evalJsonl: string, anchorOn: boolean, country: string, outName: string): Promise<void> => {
		// Anchor OFF = oa-resolver-eval's `--anchor-off` (overrides.anchor=false — the sanctioned,
		// declared ablation; #887). The old idiom (an empty-anchor.json fed as --model-anchor-lookup)
		// is refused by the #718 fail-closed gate: a lookup parsing to size 0 → UnfedChannelError.
		const anchorArgs = anchorOn ? ["--model-anchor-lookup", lookup] : ["--anchor-off"]
		// nothrow: oa-resolver-eval exits non-zero on its own internal regression signal even when it wrote
		// a valid report; this is a MEASUREMENT harness (loc() reads the .md), so under the bash `set -e` we
		// must not let that exit code abort before the 2x2 summary prints (it false-failed de.native_locality).
		const r = await $({
			nothrow: true,
		})`node --experimental-strip-types scripts/eval/oa-resolver-eval.ts --eval ${evalJsonl} --model ${model} --model-card ${card} --tokenizer ${tok} ${anchorArgs} --default-country ${country}`
		writeFileSync(join(out, `${outName}.md`), r.stdout)
		writeFileSync(join(out, `${outName}.log`), r.stderr)
	}

	// Pull the neural locality-match % out of a result .md (the "| **neural** | XX.X% |" row).
	const loc = (name: string): string => {
		let md: string

		try {
			md = readFileSync(join(out, `${name}.md`), "utf-8")
		} catch {
			return ""
		}

		for (const line of md.split("\n")) {
			if (!line.includes("**neural**")) continue
			const m = line.match(/[0-9]+\.[0-9]+%/)

			if (m) return m[0]
		}

		return ""
	}

	console.log("== DE native, anchor ON ==")
	await run(deNative, true, "DE", "de-native-on")
	console.log("== DE native, anchor OFF ==")
	await run(deNative, false, "DE", "de-native-off")
	console.log("== DE intl,   anchor ON ==")
	await run(deIntl, true, "DE", "de-intl-on")
	console.log("== DE intl,   anchor OFF ==")
	await run(deIntl, false, "DE", "de-intl-off")
	console.log("== US (anchor ON) ==")
	await run("data/eval/external/openaddresses-us-sample.jsonl", true, "US", "us-on")
	console.log("== FR (anchor ON) ==")
	await run("data/eval/external/openaddresses-fr-sample.jsonl", true, "FR", "fr-on")

	console.log("")
	console.log(`### Order-robustness 2x2 — DE locality-match (model: ${model})`)
	console.log("|            | anchor OFF | anchor ON |")
	console.log("| ---------- | ---------: | --------: |")
	console.log(`| US order   | ${loc("de-intl-off")}   | ${loc("de-intl-on")} |`)
	console.log(`| native DE  | ${loc("de-native-off")} | ${loc("de-native-on")} |`)
	console.log("")
	console.log(`no-regression: US ${loc("us-on")} · FR ${loc("fr-on")}`)
})
