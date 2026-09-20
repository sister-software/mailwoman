import { stringifyJSON } from "@mailwoman/core/json"
import { createNewlineWriter, JSONSpliterator } from "spliterator"

/**
 * Re-emit a canonical jsonl ({raw, components, country, source, ...}) as a labeled jsonl in the current align format,
 * by running every row through `alignRow` (corpus/src/align.ts).
 *
 * ## Why this exists
 *
 * Most synthetic recipe outputs are generated on demand by a recipe (parametrized by --count), so re-emitting them in a
 * new label format is just a re-run. A few are fixed corpora with a hand/DeepSeek-authored canonical source that is
 * never regenerated — notably `deepseek-kryptonite` (the adversarial hard-case set) and the `deepseek-translit-*`
 * variants. Their committed parquets carry whatever label format was current when they were first built.
 *
 * When the corpus label format changes (the v0.5.0 char-offset triple, #519), those fixed corpora must be RE-aligned
 * rather than regenerated — feed the canonical source back through the same `alignRow` the from-source build uses, so
 * the spans land in the new format with zero drift. That is exactly what this does: canonical jsonl in → labeled jsonl
 * out, one `alignRow` per row, quarantine on miss.
 *
 * It is the uniform counterpart to `tools/overlay/kryptonite.ts` (which couples to a base manifest and writes parquet
 * directly). Output goes to jsonl so it joins the same jsonl-to-parquet path every other overlay uses.
 *
 * Usage: mailwoman corpus align-slice\
 * --input /path/canonical-kryptonite.jsonl\
 * --out /tmp/kryptonite-labeled.jsonl\
 * --corpus-version 0.5.0
 */
import { alignRow } from "#utils"

export interface AlignCanonicalOptions {
	input: string
	output: string
	corpusVersion: string
}

export async function alignCanonicalRows(args: AlignCanonicalOptions): Promise<void> {
	await using outStream = createNewlineWriter(args.output)
	let labeled = 0
	let quarantined = 0
	const quarantineReasons: Record<string, number> = {}

	for await (const canonical of JSONSpliterator.fromAsync<Parameters<typeof alignRow>[0]>(args.input)) {
		// Stamp the target corpus version so the emitted row's provenance matches the run it joins.
		canonical.corpus_version = args.corpusVersion
		const result = alignRow(canonical)

		if (result.kind === "labeled") {
			await outStream.write(stringifyJSON(result.row))

			labeled++
		} else {
			quarantined++
			const r = result.row.reason ?? "unknown"
			quarantineReasons[r] = (quarantineReasons[r] ?? 0) + 1
		}
	}

	console.error(
		`align-canonical: ${labeled} labeled, ${quarantined} quarantined → ${args.output}\n` +
			`  quarantine reasons: ${stringifyJSON(quarantineReasons)}`
	)
}
