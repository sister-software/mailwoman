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
 *   substantially an eval-order artifact (docs/articles/evals/resolver-geo/2026-06-06-anchor-pilot.md); this
 *   makes native-vs-international a first-class, repeatable measurement instead of a one-off.
 *   Self-emits every figure (each run writes its own .md), then prints a 2x2 + US/FR summary. NOTE:
 *   anchor on/off only differs for an anchor-trained (4-input) model; for a plain model both
 *   columns are identical (the anchor inputs are ignored / absent).
 *
 *   The promotion gate calls {@linkcode deOrderEval} IN-PROCESS and captures its report into
 *   `<out-dir>/<tag>-deorder.md` — the file the verdict assembler regex-reads for
 *   `de.native_locality` (the `native DE` row's anchor-ON cell). Each of the six inner
 *   `oaResolverEval` runs is likewise in-process now; their markdown still lands in
 *   `<out>/<name>.md` and their narration in `<out>/<name>.log`, byte-for-byte as the child
 *   processes wrote them.
 *
 *   Usage: node scripts/eval/de-order-eval.ts\
 *   --model /tmp/v092-eval/model.onnx --card /tmp/v092-eval/model-card.json\
 *   --tokenizer $MAILWOMAN_DATA_ROOT/models/tokenizer/v0.6.0-a0/tokenizer.model\
 *   --anchor-lookup $MAILWOMAN_DATA_ROOT/anchor/pilot-anchor-lookup.json\
 *   --out /tmp/v092-eval
 */

import { dataRootPath, tempRootPath } from "@mailwoman/core/utils"
import { mkdirSync, readFileSync, writeFileSync } from "@mailwoman/platform/fs"
import { join } from "@mailwoman/platform/path"
import { TextSpliterator } from "spliterator"

import { oaResolverEval } from "./oa-resolver-eval.ts"

/**
 * Options for {@linkcode deOrderEval} — one field per flag the gate used to serialize into argv.
 */
export interface DeOrderEvalOptions {
	/**
	 * Candidate ONNX. Required.
	 */
	model?: string
	/**
	 * Candidate model-card. Required.
	 */
	card?: string
	/**
	 * SentencePiece tokenizer. Default: the v0.6.0-a0 tokenizer under `$MAILWOMAN_DATA_ROOT`.
	 */
	tokenizer?: string
	/**
	 * Anchor lookup JSON. Default: the pilot lookup under `$MAILWOMAN_DATA_ROOT`.
	 */
	anchorLookup?: string
	/**
	 * Where the six per-run `.md`/`.log` pairs land. Default `/tmp/order-eval`.
	 */
	out?: string
}

/**
 * What {@linkcode deOrderEval} returns. `ok` is false only for the usage refusal the script signalled with exit 1
 * (missing model/card) — the gate tolerated that exit code, and tolerates this the same way.
 */
export interface DeOrderEvalResult {
	ok: boolean
	out: string
}

/**
 * Run the both-order robustness battery. Every report line goes through `report` (stdout parity) and the usage refusal
 * through `reportError`, matching the `${stdout}${stderr}` capture the gate writes into `<tag>-deorder.md`.
 */
export async function deOrderEval(
	options: DeOrderEvalOptions = {},
	report: (line: string) => void = console.log,
	reportError: (line: string) => void = console.error
): Promise<DeOrderEvalResult> {
	const model = options.model ?? ""
	const card = options.card ?? ""
	const tok = options.tokenizer ?? String(dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model"))
	const lookup = options.anchorLookup ?? String(dataRootPath("anchor", "pilot-anchor-lookup.json"))
	const out = options.out ?? tempRootPath("order-eval")

	if (!model || !card) {
		reportError("need --model and --card")

		return { ok: false, out }
	}

	mkdirSync(out, { recursive: true })
	const deNative = "data/eval/external/openaddresses-de-sample-native-order.jsonl"
	const deIntl = "data/eval/external/openaddresses-de-sample.jsonl"

	// run <eval-jsonl> <anchor-on> <default-country> <out-name>
	const run = async (evalJsonl: string, anchorOn: boolean, country: string, outName: string): Promise<void> => {
		// Anchor OFF = oa-resolver-eval's `anchorOff` (overrides.anchor=false — the sanctioned, declared
		// ablation; #887). The old idiom (an empty-anchor.json fed as the anchor lookup) is refused by the
		// #718 fail-closed gate: a lookup parsing to size 0 → UnfedChannelError.
		const anchorOptions = anchorOn ? { modelAnchorLookup: lookup } : { anchorOff: true }

		// The try/catch is the in-process spelling of the `nothrow:` this call used to carry.
		// oa-resolver-eval signals its own internal regression by exiting non-zero even when it wrote a
		// valid report; this is a MEASUREMENT harness (loc() reads the .md), so a thrown failure must not
		// abort before the 2x2 summary prints (it false-failed de.native_locality). The two sinks stay
		// separate because the child's stdout and stderr went to two different files.
		const outLines: string[] = []
		const errLines: string[] = []

		try {
			await oaResolverEval(
				{
					eval: evalJsonl,
					model,
					modelCard: card,
					tokenizer: tok,
					...anchorOptions,
					defaultCountry: country,
				},
				(line) => outLines.push(line),
				(line) => errLines.push(line)
			)
		} catch (error) {
			errLines.push(error instanceof Error ? (error.stack ?? error.message) : String(error))
		}

		writeFileSync(join(out, `${outName}.md`), outLines.map((line) => `${line}\n`).join(""))
		writeFileSync(join(out, `${outName}.log`), errLines.map((line) => `${line}\n`).join(""))
	}

	// Pull the neural locality-match % out of a result .md (the "| **neural** | XX.X% |" row).
	const loc = (name: string): string => {
		let md: string

		try {
			md = readFileSync(join(out, `${name}.md`), "utf8")
		} catch {
			return ""
		}

		for (const line of TextSpliterator.from(md)) {
			if (!line.includes("**neural**")) continue
			const m = line.match(/[0-9]+\.[0-9]+%/)

			if (m) return m[0]
		}

		return ""
	}

	report("== DE native, anchor ON ==")

	await run(deNative, true, "DE", "de-native-on")

	report("== DE native, anchor OFF ==")

	await run(deNative, false, "DE", "de-native-off")

	report("== DE intl,   anchor ON ==")

	await run(deIntl, true, "DE", "de-intl-on")

	report("== DE intl,   anchor OFF ==")

	await run(deIntl, false, "DE", "de-intl-off")

	report("== US (anchor ON) ==")

	await run("data/eval/external/openaddresses-us-sample.jsonl", true, "US", "us-on")

	report("== FR (anchor ON) ==")

	await run("data/eval/external/openaddresses-fr-sample.jsonl", true, "FR", "fr-on")

	report("")
	report(`### Order-robustness 2x2 — DE locality-match (model: ${model})`)
	report("|            | anchor OFF | anchor ON |")
	report("| ---------- | ---------: | --------: |")
	report(`| US order   | ${loc("de-intl-off")}   | ${loc("de-intl-on")} |`)
	report(`| native DE  | ${loc("de-native-off")} | ${loc("de-native-on")} |`)
	report("")
	report(`no-regression: US ${loc("us-on")} · FR ${loc("fr-on")}`)

	return { ok: true, out }
}
