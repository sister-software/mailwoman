#!/usr/bin/env node
import { createWriteStream } from "node:fs"

/**
 * Re-emit a CANONICAL jsonl ({raw, components, country, source, ...}) as a LABELED jsonl in the CURRENT align format,
 * by running every row through `alignRow` (corpus/src/align.ts).
 *
 * ## Why this exists
 *
 * Most synthetic shards are GENERATED on demand by a `build-*-shard` recipe (parametrized by --count), so re-emitting
 * them in a new label format is just a re-run. A few shards are FIXED corpora with a hand/DeepSeek-authored canonical
 * source that is never regenerated — notably `deepseek-kryptonite` (the adversarial hard-case set) and the
 * `deepseek-translit-*` variants. Their committed parquets carry whatever label format was current when they were first
 * built.
 *
 * When the corpus label format changes (the v0.5.0 char-offset triple, #519), those fixed shards must be RE-ALIGNED,
 * not regenerated — feed the canonical source back through the same `alignRow` the from-source build uses, so the spans
 * land in the new format with zero drift. That is exactly what this does: canonical jsonl in → labeled jsonl out, one
 * `alignRow` per row, quarantine on miss.
 *
 * It is the uniform counterpart to corpus/scripts/build-kryptonite-shard.ts (which couples to a base manifest and
 * writes parquet directly). Output goes to jsonl so it joins the SAME jsonl-to-parquet path every other overlay shard
 * uses.
 *
 * Usage: node scripts/align-canonical-shard.ts\
 * --input /path/canonical-kryptonite.jsonl\
 * --output /tmp/kryptonite-labeled.jsonl\
 * --corpus-version 0.5.0
 */
import { alignRow } from "@mailwoman/corpus"
import { TextSpliterator } from "spliterator"

export interface AlignShardOptions {
	input: string
	output: string
	corpusVersion: string
}

export async function alignCanonicalShard(args: AlignShardOptions): Promise<void> {
	// Read phase only — the write path stays on createWriteStream. TextSpliterator + JSON.parse keeps the
	// original tolerance: the `!line.trim()` guard skips blank lines and a trailing CR is valid JSON whitespace.
	const outStream = createWriteStream(args.output, { encoding: "utf8" })
	let labeled = 0
	let quarantined = 0
	const quarantineReasons: Record<string, number> = {}

	for await (const line of TextSpliterator.fromAsync(args.input)) {
		if (!line.trim()) continue
		const canonical = JSON.parse(line) as Parameters<typeof alignRow>[0]
		// Stamp the target corpus version so the emitted row's provenance matches the run it joins.
		canonical.corpus_version = args.corpusVersion
		const result = alignRow(canonical)

		if (result.kind === "labeled") {
			outStream.write(JSON.stringify(result.row) + "\n")
			labeled++
		} else {
			quarantined++
			const r = result.row.reason ?? "unknown"
			quarantineReasons[r] = (quarantineReasons[r] ?? 0) + 1
		}
	}
	await new Promise<void>((res) => outStream.end(res))
	console.error(
		`align-canonical-shard: ${labeled} labeled, ${quarantined} quarantined → ${args.output}\n` +
			`  quarantine reasons: ${JSON.stringify(quarantineReasons)}`
	)
}
