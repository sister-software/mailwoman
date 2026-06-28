/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Both-order order-robustness eval harness (S6). Runs a model through the resolver on German
 *   addresses in BOTH renderings — native German order (the realistic layout) and US/international
 *   order (the layout our OA de-sample ships) — with the postcode anchor fed and zeroed, plus US +
 *   FR for the no-regression gate. The German "collapse" was substantially an eval-order artifact
 *   (docs/articles/evals/2026-06-06-anchor-pilot.md); this makes native-vs-international a
 *   first-class, repeatable measurement instead of a one-off. Self-emits every figure (each run
 *   writes its own .md), then prints a 2x2 + US/FR summary. NOTE: anchor on/off only differs for an
 *   anchor-trained (4-input) model; for a plain model both columns are identical (the anchor inputs
 *   are ignored / absent).
 *
 *   Usage: node --experimental-strip-types scripts/eval/de-order-eval.ts\
 *   --model /tmp/v092-eval/model.onnx --card /tmp/v092-eval/model-card.json\
 *   --tokenizer $MAILWOMAN_DATA_ROOT/models/tokenizer/v0.6.0-a0/tokenizer.model\
 *   --anchor-lookup $MAILWOMAN_DATA_ROOT/anchor/pilot-anchor-lookup.json\
 *   --out /tmp/v092-eval
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { dataRootPath } from "@mailwoman/core/utils"
import { $ } from "zx"

import { runIfScript } from "mailwoman/sdk/scripting"

runIfScript(import.meta, async () => {
	$.verbose = false

	let model = ""
	let card = ""
	let tok = dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model")
	let lookup = dataRootPath("anchor", "pilot-anchor-lookup.json")
	let out = "/tmp/order-eval"

	const argv = process.argv.slice(2)
	for (let i = 0; i < argv.length; i++) {
		switch (argv[i]) {
			case "--model":
				model = argv[++i]!
				break
			case "--card":
				card = argv[++i]!
				break
			case "--tokenizer":
				tok = argv[++i]!
				break
			case "--anchor-lookup":
				lookup = argv[++i]!
				break
			case "--out":
				out = argv[++i]!
				break
			default:
				console.error(`unknown arg: ${argv[i]}`)
				process.exit(1)
		}
	}
	if (!model || !card) {
		console.error("need --model and --card")
		process.exit(1)
	}

	mkdirSync(out, { recursive: true })
	const empty = join(out, "empty-anchor.json")
	writeFileSync(empty, "{}") // zeroed anchor = c=0 identity = "anchor off"
	const deNative = "data/eval/external/openaddresses-de-sample-native-order.jsonl"
	const deIntl = "data/eval/external/openaddresses-de-sample.jsonl"

	// run <eval-jsonl> <anchor-lookup> <default-country> <out-name>
	const run = async (evalJsonl: string, anchorLookup: string, country: string, outName: string): Promise<void> => {
		// nothrow: oa-resolver-eval exits non-zero on its own internal regression signal even when it wrote
		// a valid report; this is a MEASUREMENT harness (loc() reads the .md), so under the bash `set -e` we
		// must not let that exit code abort before the 2x2 summary prints (it false-failed de.native_locality).
		const r = await $({
			nothrow: true,
		})`node --experimental-strip-types scripts/eval/oa-resolver-eval.ts --eval ${evalJsonl} --model ${model} --model-card ${card} --tokenizer ${tok} --model-anchor-lookup ${anchorLookup} --default-country ${country}`
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
	await run(deNative, lookup, "DE", "de-native-on")
	console.log("== DE native, anchor OFF ==")
	await run(deNative, empty, "DE", "de-native-off")
	console.log("== DE intl,   anchor ON ==")
	await run(deIntl, lookup, "DE", "de-intl-on")
	console.log("== DE intl,   anchor OFF ==")
	await run(deIntl, empty, "DE", "de-intl-off")
	console.log("== US (anchor ON) ==")
	await run("data/eval/external/openaddresses-us-sample.jsonl", lookup, "US", "us-on")
	console.log("== FR (anchor ON) ==")
	await run("data/eval/external/openaddresses-fr-sample.jsonl", lookup, "FR", "fr-on")

	console.log("")
	console.log(`### Order-robustness 2x2 — DE locality-match (model: ${model})`)
	console.log("|            | anchor OFF | anchor ON |")
	console.log("| ---------- | ---------: | --------: |")
	console.log(`| US order   | ${loc("de-intl-off")}   | ${loc("de-intl-on")} |`)
	console.log(`| native DE  | ${loc("de-native-off")} | ${loc("de-native-on")} |`)
	console.log("")
	console.log(`no-regression: US ${loc("us-on")} · FR ${loc("fr-on")}`)
})
