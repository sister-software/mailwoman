/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Both-order order-robustness eval harness over German addresses in native and international order with the postcode anchor fed and ablated, where the anchor setting differs only for an anchor-trained four-input model.
 */

import { dataRootPath, tempRootPathBuilder } from "@mailwoman/core/data-root"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile, makeDirectories } from "@mailwoman/core/fs/writers"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { TextSpliterator } from "spliterator"

import { oaResolverEval } from "#eval-harness/oa/resolver/eval"

/**
 * The six runs in execution order, of which only `de-native-on` feeds a promotion floor.
 */
export const DE_ORDER_RUNS = ["de-native-on", "de-native-off", "de-intl-on", "de-intl-off", "us-on", "fr-on"] as const

export type DeOrderRunName = (typeof DE_ORDER_RUNS)[number]

interface DeOrderRun {
	name: DeOrderRunName
	/**
	 * The heading this run prints, byte-identical to what the check has always
	 * written into `<tag>-deorder.md`.
	 */
	heading: string
	evalJSONL: string
	anchorOn: boolean
	country: string
}

const DE_NATIVE = "data/eval/external/openaddresses-de-sample-native-order.jsonl"
const DE_INTL = "data/eval/external/openaddresses-de-sample.jsonl"

const RUN_PLAN: readonly DeOrderRun[] = [
	{ name: "de-native-on", heading: "== DE native, anchor ON ==", evalJSONL: DE_NATIVE, anchorOn: true, country: "DE" },
	{
		name: "de-native-off",
		heading: "== DE native, anchor OFF ==",
		evalJSONL: DE_NATIVE,
		anchorOn: false,
		country: "DE",
	},
	{ name: "de-intl-on", heading: "== DE intl,   anchor ON ==", evalJSONL: DE_INTL, anchorOn: true, country: "DE" },
	{ name: "de-intl-off", heading: "== DE intl,   anchor OFF ==", evalJSONL: DE_INTL, anchorOn: false, country: "DE" },
	{
		name: "us-on",
		heading: "== US (anchor ON) ==",
		evalJSONL: "data/eval/external/openaddresses-us-sample.jsonl",
		anchorOn: true,
		country: "US",
	},
	{
		name: "fr-on",
		heading: "== FR (anchor ON) ==",
		evalJSONL: "data/eval/external/openaddresses-fr-sample.jsonl",
		anchorOn: true,
		country: "FR",
	},
]

/**
 * Options for {@linkcode deOrderEval}, one field per flag the check used to serialize into argv.
 */
export interface DeOrderEvalOptions {
	/**
	 * Candidate ONNX, required.
	 */
	model?: string
	/**
	 * Candidate model-card, required.
	 */
	card?: string
	/**
	 * SentencePiece tokenizer, defaulting to the v0.6.0-a0 tokenizer under `$MAILWOMAN_DATA_ROOT`.
	 */
	tokenizer?: PathBuilderLike
	/**
	 * Anchor lookup JSON, defaulting to the pilot lookup under `$MAILWOMAN_DATA_ROOT`.
	 */
	anchorLookup?: PathBuilderLike
	/**
	 * Where the six per-run `.md`/`.log` pairs land, defaulting to `<temp-root>/order-eval`.
	 */
	out?: PathBuilderLike
	/**
	 * Row cap applied to each run (omitted means all rows), profiling only, since a capped run reads the
	 * first N rows in file order and its locality percentages are not comparable with a floor reading.
	 */
	limit?: number
	/**
	 * Answers a repeated `findPlace` query from a per-run memo, each of the six runs
	 * keeping its own because each builds its own rig.
	 */
	lookupMemo?: boolean
	/**
	 * Which of {@linkcode DE_ORDER_RUNS} to execute, omitted meaning all six, where an
	 * unselected cell reads `—` so it cannot be read as a cell that measured no row.
	 */
	runs?: readonly DeOrderRunName[]
	/**
	 * Directory for one `<run-name>.json` wall-time attribution file per run,
	 * profiling only and required to sit outside the promotion output directory
	 * because the receipt comparator reads every file there byte-for-byte.
	 */
	profileDirectory?: PathBuilderLike
}

/**
 * What {@linkcode deOrderEval} returns, with `ok` false only for the usage refusal
 * when model or card is missing.
 */
export interface DeOrderEvalResult {
	ok: boolean
	out: string
}

/**
 * Runs the both-order robustness battery, routing every report line through `report`
 * and the usage refusal through `reportError` to match the runner's captured output.
 */
export async function deOrderEval(
	options: DeOrderEvalOptions = {},
	report: (line: string) => void = console.log,
	reportError: (line: string) => void = console.error
): Promise<DeOrderEvalResult> {
	const model = options.model ?? ""
	const card = options.card ?? ""
	const tok = PathBuilder.from(options.tokenizer ?? dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model"))
	const lookup = PathBuilder.from(options.anchorLookup ?? dataRootPath("anchor", "pilot-anchor-lookup.json"))
	const out = PathBuilder.from(options.out ?? tempRootPathBuilder("order-eval"))

	if (!model || !card) {
		reportError("need --model and --card")

		return { ok: false, out: out.toString() }
	}

	const profileDirectory = options.profileDirectory ? PathBuilder.from(options.profileDirectory) : undefined

	await makeDirectories(out)

	if (profileDirectory) {
		await makeDirectories(profileDirectory)
	}

	const selected = new Set<DeOrderRunName>(options.runs ?? DE_ORDER_RUNS)

	const run = async ({ name: outName, evalJSONL, anchorOn, country }: DeOrderRun): Promise<void> => {
		// Anchor off maps to oa-resolver-eval's `anchorOff`; an empty lookup is refused
		// by the fail-closed check as an UnfedChannelError.
		const anchorOptions = anchorOn ? { modelAnchorLookup: lookup } : { anchorOff: true }

		// Oa-resolver-eval exits non-zero even when it wrote a valid report,
		// so the throw is caught and the two sinks stay separate.
		const outLines: string[] = []
		const errLines: string[] = []

		try {
			await oaResolverEval(
				{
					eval: evalJSONL,
					model,
					modelCard: card,
					tokenizer: tok,
					...anchorOptions,
					defaultCountry: country,
					...(options.limit ? { limit: options.limit } : {}),
					...(options.lookupMemo ? { lookupMemo: true } : {}),
					...(profileDirectory ? { profileJSON: profileDirectory(`${outName}.json`).toString() } : {}),
				},
				(line) => outLines.push(line),
				(line) => errLines.push(line)
			)
		} catch (error) {
			errLines.push(error instanceof Error ? (error.stack ?? error.message) : String(error))
		}

		await writeLocalTextFile(outLines.map((line) => `${line}\n`).join(""), out(`${outName}.md`))
		await writeLocalTextFile(errLines.map((line) => `${line}\n`).join(""), out(`${outName}.log`))
	}

	// Pull the neural locality-match % out of a result .md (the "| **neural** | XX.X% |" row).
	const loc = async (name: DeOrderRunName): Promise<string> => {
		// An unselected run reads `—` and a selected run that wrote no locality row
		// reads empty, because the two are different facts.
		if (!selected.has(name)) return "—"

		let md: string

		try {
			md = await readLocalTextFile(out(`${name}.md`))
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

	for (const entry of RUN_PLAN) {
		if (!selected.has(entry.name)) {
			report(`${entry.heading} SKIPPED`)

			continue
		}

		report(entry.heading)

		await run(entry)
	}

	report("")
	report(`### Order-robustness 2x2 — DE locality-match (model: ${model})`)
	report("|            | anchor OFF | anchor ON |")
	report("| ---------- | ---------: | --------: |")
	report(`| US order   | ${await loc("de-intl-off")}   | ${await loc("de-intl-on")} |`)
	report(`| native DE  | ${await loc("de-native-off")} | ${await loc("de-native-on")} |`)
	report("")
	report(`no-regression: US ${await loc("us-on")} · FR ${await loc("fr-on")}`)

	return { ok: true, out: out.toString() }
}
