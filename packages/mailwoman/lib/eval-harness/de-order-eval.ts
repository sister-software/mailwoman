/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Both-order order-robustness eval harness (S6). Runs a model through the resolver on German
 *   addresses in BOTH renderings — native German order (the realistic layout) and US/international
 *   order (the layout our OA de-sample ships) — with the postcode anchor fed and ablated
 *   (oa-resolver-eval's `--anchor-off` → `overrides.anchor=false`, the #718-sanctioned declared
 *   ablation; #887), plus US + FR for the no-regression check. The German "collapse" was
 *   substantially an eval-order artifact (docs/articles/evals/resolver-geo/2026-06-06-anchor-pilot.md); this
 *   makes native-vs-international a first-class, repeatable measurement instead of a one-off.
 *   Self-emits every figure (each run writes its own .md), then prints a 2x2 + US/FR summary. NOTE:
 *   anchor on/off only differs for an anchor-trained (4-input) model; for a plain model both
 *   columns are identical (the anchor inputs are ignored / absent).
 *
 *   `promotion-eval.ts` calls {@linkcode deOrderEval} IN-PROCESS and captures its report into
 *   `<out-dir>/<tag>-deorder.md` — the file the verdict assembler regex-reads for
 *   `de.native_locality` (the `native DE` row's anchor-ON cell). Each of the six inner
 *   `oaResolverEval` runs is likewise in-process now; their markdown still lands in
 *   `<out>/<name>.md` and their narration in `<out>/<name>.log`, byte-for-byte as the child
 *   processes wrote them.
 *
 *   Usage: node packages/mailwoman/lib/dev-tools/de-order-eval.run.ts\
 *   --model /tmp/v092-eval/model.onnx --card /tmp/v092-eval/model-card.json\
 *   --tokenizer $MAILWOMAN_DATA_ROOT/models/tokenizer/v0.6.0-a0/tokenizer.model\
 *   --anchor-lookup $MAILWOMAN_DATA_ROOT/anchor/pilot-anchor-lookup.json\
 *   --out /tmp/v092-eval
 */

import { dataRootPath, tempRootPath } from "@mailwoman/core/data-root"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile, makeDirectories } from "@mailwoman/core/fs/writers"
import { join } from "path-ts"
import { TextSpliterator } from "spliterator"

import { oaResolverEval } from "#eval-harness/oa/resolver/eval"

/**
 * The six runs, in the order they execute and by the name each writes its `.md`/`.log` under.
 *
 * `de-native-on` is the only one a promotion floor reads — the `native DE` anchor-ON cell of the 2x2 is
 * `de.native_locality`, which is also in the fp32↔int8 delta cap, so that run executes on BOTH arms. The other five are
 * recorded, not floored.
 */
export const DE_ORDER_RUNS = ["de-native-on", "de-native-off", "de-intl-on", "de-intl-off", "us-on", "fr-on"] as const

export type DeOrderRunName = (typeof DE_ORDER_RUNS)[number]

interface DeOrderRun {
	name: DeOrderRunName
	/**
	 * The heading this run prints, byte-identical to what the check has always written into `<tag>-deorder.md`.
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
 * Options for {@linkcode deOrderEval} — one field per flag the check used to serialize into argv.
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
	/**
	 * Row cap applied to EACH of the six runs (0/omitted = all rows).
	 *
	 * PROFILING ONLY. The six corpora are 3,000 rows each except the US no-regression run at 10,000, and a capped run
	 * reads the first N rows in file order — which is not a stratified sample. A capped run's locality percentages are
	 * therefore not comparable with a floor reading, and `promotion-eval.ts` never passes this.
	 */
	limit?: number
	/**
	 * Answer a repeated `findPlace` query from a per-run memo (see `OAResolverEvalOptions.lookupMemo`). Each of the six
	 * runs keeps its own memo, because each builds its own rig.
	 */
	lookupMemo?: boolean
	/**
	 * Which of {@linkcode DE_ORDER_RUNS} to execute. Omitted runs all six.
	 *
	 * A run not selected prints its heading with `SKIPPED` and its 2x2 cell reads `—`, so a cell nobody measured cannot
	 * be read as a cell that measured nothing. Selecting a subset that omits `de-native-on` produces no
	 * `de.native_locality` and fails the promotion verdict, which is the correct outcome rather than a silent absence.
	 */
	runs?: readonly DeOrderRunName[]
	/**
	 * Write one `<run-name>.json` wall-time attribution file per run into this directory.
	 *
	 * PROFILING ONLY, and it must name somewhere OUTSIDE the promotion output directory: the receipt comparator reads
	 * every file under that directory byte-for-byte, and a timing number differs between two runs of the same artifact.
	 */
	profileDirectory?: string
}

/**
 * What {@linkcode deOrderEval} returns. `ok` is false only for the usage refusal the script signalled with exit 1
 * (missing model/card) — the check tolerated that exit code, and tolerates this the same way.
 */
export interface DeOrderEvalResult {
	ok: boolean
	out: string
}

/**
 * Run the both-order robustness battery. Every report line goes through `report` (stdout parity) and the usage refusal
 * through `reportError`, matching the `${stdout}${stderr}` capture the runner writes into `<tag>-deorder.md`.
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

	const profileDirectory = options.profileDirectory ?? ""

	await makeDirectories(out)

	if (profileDirectory) {
		await makeDirectories(profileDirectory)
	}

	const selected = new Set<DeOrderRunName>(options.runs ?? DE_ORDER_RUNS)

	const run = async ({ name: outName, evalJSONL, anchorOn, country }: DeOrderRun): Promise<void> => {
		// Anchor OFF = oa-resolver-eval's `anchorOff` (overrides.anchor=false — the sanctioned, declared
		// ablation; #887). The old idiom (an empty-anchor.json fed as the anchor lookup) is refused by the
		// #718 fail-closed check: a lookup parsing to size 0 → UnfedChannelError.
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
					eval: evalJSONL,
					model,
					modelCard: card,
					tokenizer: tok,
					...anchorOptions,
					defaultCountry: country,
					...(options.limit ? { limit: options.limit } : {}),
					...(options.lookupMemo ? { lookupMemo: true } : {}),
					...(profileDirectory ? { profileJSON: String(join(profileDirectory, `${outName}.json`)) } : {}),
				},
				(line) => outLines.push(line),
				(line) => errLines.push(line)
			)
		} catch (error) {
			errLines.push(error instanceof Error ? (error.stack ?? error.message) : String(error))
		}

		await writeLocalTextFile(outLines.map((line) => `${line}\n`).join(""), join(out, `${outName}.md`))
		await writeLocalTextFile(errLines.map((line) => `${line}\n`).join(""), join(out, `${outName}.log`))
	}

	// Pull the neural locality-match % out of a result .md (the "| **neural** | XX.X% |" row).
	const loc = async (name: DeOrderRunName): Promise<string> => {
		// A run nobody asked for reads `—`, not empty. An empty cell is what a SELECTED run leaves when it wrote no
		// locality row, and the two readings are different facts.
		if (!selected.has(name)) return "—"

		let md: string

		try {
			md = await readLocalTextFile(join(out, `${name}.md`))
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

	return { ok: true, out }
}
