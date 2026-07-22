/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer pair-index` — build the PIX1 placetype-pair index (placetype-pair-prior
 *   arc, Task 3) from the HM Land Registry PPD tuples CSV (`corpus/src/tools/fetch/ppd.ts`'s
 *   `gb-tuples.csv`; columns `NUMBER,STREET,CITY,DISTRICT,REGION,POSTCODE`). Streams the CSV
 *   (CSVSpliterator, the `corpus/src/shard-recipes/locale.ts` `readTuples` idiom), folds
 *   child=CITY/parent=DISTRICT through `normalizeFSTToken` and tags every pair `dependent_locality`
 *   (`PairIndexBuilder`, `gazetteer-pipeline/pair-index.ts` — the extracted, unit-tested fold/dedupe/
 *   skip logic), then writes `pair-index-<country>.bin` via `serializePairIndex`.
 *
 *   `--delta` is REQUIRED with no default: it's the soft-prior bias magnitude a probe hit will
 *   contribute at decode time, and the calibration task (not this one) owns the real value — a
 *   silent default here would let an uncalibrated number ship unnoticed.
 *
 *   Self-verifying (the sealed-artifact spirit — see AGENTS.md's database section, which this
 *   mirrors for a flat binary): after writing, the command re-reads the bytes through a fresh
 *   `PairIndexResolver` and probes a few known (child, parent) pairs, printing `PROBE OK`/`PROBE
 *   MISS` lines rather than trusting the write silently succeeded.
 *
 *   Also prints the raw (pre-fold) CITY word-length distribution (p50/p90/p99/max + a per-length
 *   count table) — this sizes the word-span window the decode-side prior (Task 4) walks.
 */

import { createReadStream, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { dataRootPath, md5File } from "@mailwoman/core/utils"
// @mailwoman/neural's fst-prior and pair-index-resolver subpaths are self-contained (fst-prior only
// type-imports from a sibling module; pair-index-resolver only imports core/types) — safe value
// imports at module level, no heavy ONNX runtime pulled in (mirrors postcode-binary.tsx's comment).
import { normalizeFSTToken } from "@mailwoman/neural/fst-prior"
import { PairIndexResolver, serializePairIndex, type PairIndexHeader } from "@mailwoman/neural/pair-index-resolver"
import { Box, Text } from "ink"
import { CSVSpliterator } from "spliterator"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"
import { PairIndexBuilder } from "../../gazetteer-pipeline/pair-index.ts"

/**
 * The rung-3 census's distinct-pair count for the GB source (`scratchpad/gb-probe-grade/census-gb-pairs.jsonl`, 19,431
 * lines) — the cross-check this build must reproduce. A mismatch means this build's fold diverged from that census's,
 * not that the census was wrong; investigate before trusting the artifact.
 */
const EXPECTED_GB_PAIR_COUNT = 19_431

/** Known (child, parent) pairs from the rung-3 GB census, probed after write as a self-check. */
const GB_PROBE_PAIRS: ReadonlyArray<readonly [city: string, district: string]> = [
	["Fishburn", "Stockton-on-Tees"],
	["Shoreditch", "London"],
	["Sedgefield", "Stockton-on-Tees"],
]

const OptionsSchema = zod.object({
	out: zod.string().default("docs/static/mailwoman").describe("Output dir for pair-index-<country>.bin"),
	country: zod.string().default("gb").describe("ISO country code this shard is built for"),
	source: zod.string().optional().describe("Source PPD tuples CSV. Default <data-root>/ppd/2026-07-22/gb-tuples.csv"),
	delta: zod
		.number()
		.describe(
			"REQUIRED, no default — the soft-prior bias magnitude a probe hit contributes at decode time. " +
				"The calibration task supplies the real value; this command refuses to default it silently."
		),
})

export { OptionsSchema as options }

const GazetteerPairIndex: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const country = options.country.toLowerCase()
		const sourcePath = options.source ?? dataRootPath("ppd", "2026-07-22", "gb-tuples.csv")

		if (!existsSync(sourcePath)) {
			throw new Error(`pair-index: source CSV not found: ${sourcePath}`)
		}

		const builder = new PairIndexBuilder()
		let header: string[] | null = null
		let cityIx = -1
		let districtIx = -1

		// Same CSVSpliterator idiom as `corpus/src/shard-recipes/locale.ts`'s `readTuples`: array mode, no header
		// row consumed by the parser (`header: false`), so we build the column index off the first yielded row
		// ourselves and skip forward from there.
		for await (const cells of CSVSpliterator.fromAsync<string[]>(createReadStream(sourcePath), {
			mode: "array",
			header: false,
			enableQuoteHandling: true,
		})) {
			if (header === null) {
				header = cells.map((h) => h.trim().toUpperCase())
				cityIx = header.indexOf("CITY")
				districtIx = header.indexOf("DISTRICT")

				if (cityIx < 0 || districtIx < 0) {
					throw new Error(`pair-index: source header is missing CITY/DISTRICT: ${header.join(",")}`)
				}

				continue
			}

			builder.addRow(cells[cityIx] ?? "", cells[districtIx] ?? "")
		}

		const { entries, rowsKept, rowsSkipped, distribution } = builder.finish()
		const sourceMD5 = await md5File(sourcePath)

		const pairIndexHeader: PairIndexHeader = {
			country,
			delta: options.delta,
			schemaVersion: 1,
			foldVersion: 1,
			sourceMD5s: [sourceMD5],
			buildDate: new Date().toISOString(),
		}

		const bytes = serializePairIndex(pairIndexHeader, entries)
		const outPath = join(options.out, `pair-index-${country}.bin`)

		writeFileSync(outPath, bytes)

		// Self-verifying readback: construct a fresh resolver over the bytes we just wrote (not the in-memory
		// `entries`) and probe known pairs, rather than trusting the write silently succeeded.
		const resolver = new PairIndexResolver(bytes)
		const probeLines = GB_PROBE_PAIRS.map(([city, district]) => {
			const child = normalizeFSTToken(city)
			const parent = normalizeFSTToken(district)
			const tag = resolver.probe(child, parent)

			return tag
				? `PROBE OK: fold("${city}")/fold("${district}") → "${child}"/"${parent}" → ${tag}`
				: `PROBE MISS: fold("${city}")/fold("${district}") → "${child}"/"${parent}" → (no entry)`
		})

		const distLines = [
			`CITY word-length distribution (raw, pre-fold; n=${distribution.totalRows.toLocaleString()}): ` +
				`p50=${distribution.p50} p90=${distribution.p90} p99=${distribution.p99} max=${distribution.max}`,
			...distribution.counts.map(
				(b) => `  ${b.words} word${b.words === 1 ? "" : "s"}: ${b.rows.toLocaleString()} rows`
			),
		]

		const gateLine =
			country === "gb"
				? entries.length === EXPECTED_GB_PAIR_COUNT
					? `CROSS-CHECK PASS: ${entries.length.toLocaleString()} distinct pairs (rung-3 expects ${EXPECTED_GB_PAIR_COUNT.toLocaleString()})`
					: `CROSS-CHECK BLOCKED: ${entries.length.toLocaleString()} distinct pairs != rung-3's ${EXPECTED_GB_PAIR_COUNT.toLocaleString()} — investigate fold divergence before trusting this artifact`
				: `(cross-check only registered for gb; ${entries.length.toLocaleString()} distinct pairs)`

		return [
			`pair-index-${country}.bin → ${outPath} (${bytes.length.toLocaleString()} bytes)`,
			`rows kept ${rowsKept.toLocaleString()} / skipped ${rowsSkipped.toLocaleString()} (empty CITY)`,
			`distinct pairs: ${entries.length.toLocaleString()}`,
			gateLine,
			...distLines,
			...probeLines,
		]
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		return (
			<Box flexDirection="column">
				{state.result.map((line, i) => (
					<Text key={i} color={i === 0 ? "green" : undefined}>
						{i === 0 ? "✓ " : "  "}
						{line}
					</Text>
				))}
			</Box>
		)
	}

	return null
}

export default GazetteerPairIndex
