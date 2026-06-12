#!/usr/bin/env node
/**
 * Re-emit a CANONICAL jsonl ({raw, components, country, source, ...}) as a LABELED jsonl in the
 * CURRENT align format, by running every row through `alignRow` (corpus/src/align.ts).
 *
 * Why this exists
 * ---------------
 * Most synthetic shards are GENERATED on demand by a `build-*-shard.mjs` (parametrized by --count),
 * so re-emitting them in a new label format is just a re-run. A few shards are FIXED corpora with a
 * hand/DeepSeek-authored canonical source that is never regenerated — notably `deepseek-kryptonite`
 * (the adversarial hard-case set) and the `deepseek-translit-*` variants. Their committed parquets
 * carry whatever label format was current when they were first built.
 *
 * When the corpus label format changes (the v0.5.0 char-offset triple, #519), those fixed shards
 * must be RE-ALIGNED, not regenerated — feed the canonical source back through the same `alignRow`
 * the from-source build uses, so the spans land in the new format with zero drift. That is exactly
 * what this does: canonical jsonl in → labeled jsonl out, one `alignRow` per row, quarantine on miss.
 *
 * It is the uniform, tsx-free counterpart to corpus/scripts/build-kryptonite-shard.ts (which couples
 * to a base manifest and writes parquet directly). Output goes to jsonl so it joins the SAME
 * jsonl-to-parquet.py path every other overlay shard uses.
 *
 * Usage:
 *   node scripts/align-canonical-shard.mjs \
 *     --input  /path/canonical-kryptonite.jsonl \
 *     --output /tmp/kryptonite-labeled.jsonl \
 *     --corpus-version 0.5.0
 */
import { createReadStream, createWriteStream } from "node:fs"
import { createInterface } from "node:readline"
import { alignRow } from "@mailwoman/corpus"

function parseArgs(argv) {
	const out = { corpusVersion: "0.5.0" }
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a === "--input") out.input = argv[++i]
		else if (a === "--output") out.output = argv[++i]
		else if (a === "--corpus-version") out.corpusVersion = argv[++i]
		else throw new Error(`unknown arg: ${a}`)
	}
	if (!out.input) throw new Error("--input <canonical.jsonl> required")
	if (!out.output) throw new Error("--output <labeled.jsonl> required")
	return out
}

async function main() {
	const args = parseArgs(process.argv.slice(2))
	const rl = createInterface({ input: createReadStream(args.input, { encoding: "utf8" }), crlfDelay: Infinity })
	const outStream = createWriteStream(args.output, { encoding: "utf8" })
	let labeled = 0
	let quarantined = 0
	const quarantineReasons = {}
	for await (const line of rl) {
		if (!line.trim()) continue
		const canonical = JSON.parse(line)
		// Stamp the target corpus version so the emitted row's provenance matches the run it joins.
		canonical.corpus_version = args.corpusVersion
		const result = alignRow(canonical)
		if (result.kind === "labeled") {
			outStream.write(JSON.stringify(result.row) + "\n")
			labeled++
		} else {
			quarantined++
			const r = result.reason ?? "unknown"
			quarantineReasons[r] = (quarantineReasons[r] ?? 0) + 1
		}
	}
	await new Promise((res) => outStream.end(res))
	console.error(
		`align-canonical-shard: ${labeled} labeled, ${quarantined} quarantined → ${args.output}\n` +
			`  quarantine reasons: ${JSON.stringify(quarantineReasons)}`,
	)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
