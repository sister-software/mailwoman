/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Implements `mailwoman gazetteer pair-index`, which builds a per-country placetype-pair index.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import { pathExists } from "@mailwoman/core/fs/readers"
import { openReadStream } from "@mailwoman/core/fs/streams"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { extractDelimited } from "@mailwoman/core/scripting/arguments"
import type { PairIndexHeaderInput } from "@mailwoman/neural/pair"
import { Box, Text } from "ink"
import { basename, PathBuilder, type PathBuilderLike } from "path-ts"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"

/**
 * The expected distinct-pair count for a GB build from the PPD CSV alone.
 *
 * A mismatch means the fold changed, so the artifact needs investigation before use.
 */
const EXPECTED_GB_PAIR_COUNT = 19_209

/**
 * The GB pair count before folding, printed for context only.
 *
 * It exceeds {@link EXPECTED_GB_PAIR_COUNT} because the fold merges punctuation
 * variants such as "St Helens" and "St.
 * Helens".
 */
const RUNG3_PRE_FOLD_CENSUS_LINE_COUNT = 19_431

/**
 * The expected distinct-pair count for a US build.
 *
 * Every US pair comes from WOF, so a WOF snapshot refresh can legitimately change this number.
 * Update it after inspecting the difference instead of relaxing the check.
 */
const EXPECTED_US_PAIR_COUNT = 47_878

/**
 * The known (child, parent) pairs that the command probes after writing, keyed by country code.
 *
 * Each country needs its own pairs, because probing another country's names verifies nothing.
 * The command throws for a country without an entry.
 */
const PROBE_PAIRS_BY_COUNTRY: Readonly<Record<string, ReadonlyArray<readonly [city: string, district: string]>>> = {
	gb: [
		["Fishburn", "Stockton-on-Tees"],
		["Shoreditch", "London"],
		["Sedgefield", "Stockton-on-Tees"],
	],
	nz: [
		["Plimmerton", "Porirua"],
		// NZ addresses can repeat the town as its own suburb, so the index holds identity pairs.
		["Mangawhai", "Mangawhai"],
	],
	// The US pairs come from WOF boroughs and neighbourhoods.
	us: [
		["Astoria", "Queens"],
		["Park Slope", "Brooklyn"],
		["Manhattan", "New York"],
	],
	in: [
		["Indiranagar", "Bangalore"],
		["Mulund East", "Mumbai"],
	],
	es: [
		["Aravaca", "Madrid"],
		["Triana", "Sevilla"],
	],
	it: [
		["Barona", "Milano"],
		["Trastevere", "Roma"],
	],
	de: [
		["Nippes", "Köln"],
		["Schwabing", "München"],
	],
	// The FR pairs are BAN lieux-dits under their communes.
	fr: [
		["Pinsonnac", "Montpeyroux"],
		["Line", "Salignac-Eyvigues"],
	],
}

/**
 * The parent tag for each source that does not report one itself.
 *
 * The `district` column of the `--source` CSV holds the post town in GB and the town above the suburb in NZ.
 * The `--pairs-jsonl` files pair neighbourhoods and villages with their town,
 * and a line can override the tag with its own `parentTag`.
 *
 * The `--borough-db` and `--ban-dir` sources supply a tag with each pair.
 */
const SOURCE_PARENT_TAGS = {
	registerDistrict: "locality",
	secondaryPairsJSONL: "locality",
} as const satisfies Record<string, ComponentTag>

/**
 * Splits a comma-separated path list.
 *
 * The secondary sources stay separate files so that the header records an MD5 for each one.
 */
function splitPathList(value: string | undefined): string[] {
	return extractDelimited(value)
}

/**
 * The command specification for `mailwoman gazetteer pair-index`.
 *
 * The `--delta` flag has no default because its value comes from calibration.
 * The `--parent-delta` flag is optional, and omitting it leaves the parent bias off.
 */
export const spec = {
	name: "pair-index",
	description: "Build a placetype-pair index",
	options: {
		out: { type: "string", default: "docs/static/mailwoman", description: "Output directory" },
		country: { type: "string", default: "gb", description: "ISO country code" },
		source: { type: "string", description: "Source tuples CSV" },
		delta: { type: "number", required: true, description: "Soft-prior bias magnitude" },
		"transition-beta": { type: "number", description: "Transition-entry bonus" },
		"parent-delta": { type: "number", description: "Parent-window bias" },
		"holdout-fraction": {
			type: "number",
			default: 0,
			validate: (value: number) => value >= 0 && value <= 1,
			description: "Deterministic holdout fraction",
		},
		"pairs-jsonl": { type: "string", description: "Secondary pairs JSONL" },
		"borough-db": { type: "string", description: "WOF admin DB" },
		"ban-dir": { type: "string", description: "BAN source directory" },
		"holdout-seed": { type: "number", default: 42, description: "Holdout seed" },
	},
} as const satisfies CommandSpec

/**
 * Builds the pair index, verifies it and renders a summary.
 */
const GazetteerPairIndex: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { dataRootPath } = await import("@mailwoman/core/data-root")
		const { md5File, md5Hex } = await import("@mailwoman/core/utils")
		const { normalizeFSTToken } = await import("@mailwoman/neural/fst-prior")
		const { PairIndexResolver, serializePairIndex } = await import("@mailwoman/neural/pair")
		const { PairIndexBuilder, applyPairIndexHoldout } = await import("#gazetteer-pipeline/pair/index/index")
		const { CSVSpliterator, JSONSpliterator } = await import("spliterator")
		const { extractBoroughPairs } = await import("#gazetteer-pipeline/borough-pairs")
		const { extractLieuDitPairs } = await import("#gazetteer-pipeline/lieudit-pairs")

		const country = options.country.toLowerCase()

		// Only GB has a default CSV.
		// Other countries build from the secondary sources.
		const sourcePath =
			options.source ?? (country === "gb" ? dataRootPath("ppd", "2026-07-22", "gb-tuples.csv") : undefined)

		if (sourcePath && !(await pathExists(sourcePath))) {
			throw new Error(`pair-index: source CSV not found: ${sourcePath}`)
		}

		if (!sourcePath && !options.boroughDB && !options.pairsJSONL && !options.banDir) {
			throw new Error(
				`pair-index: country "${country}" has no PPD default — pass --source, --borough-db, --pairs-jsonl or --ban-dir, ` +
					`or the build would write an empty index.`
			)
		}

		const builder = new PairIndexBuilder()
		let header: string[] | null = null
		let cityIx = -1
		let districtIx = -1

		// The parser does not consume the header row, so the first row supplies the column indexes.
		if (sourcePath) {
			for await (const cells of CSVSpliterator.fromAsync<string[]>(openReadStream(sourcePath), {
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

				builder.addRow(cells[cityIx] ?? "", cells[districtIx] ?? "", SOURCE_PARENT_TAGS.registerDistrict)
			}
		}

		// The GB cross-check adds this count of distinct secondary-source pairs to its baseline.
		let secondaryPairsAdded = 0
		let banFiles: readonly PathBuilderLike[] = []

		if (options.boroughDB) {
			const before = builder.distinctCount

			for (const pair of extractBoroughPairs(options.boroughDB, country.toUpperCase())) {
				builder.addRow(pair.child, pair.parent, pair.parentTag)
			}

			secondaryPairsAdded = builder.distinctCount - before

			console.error(`pair-index: +${secondaryPairsAdded} distinct borough pairs (WOF admin DB)`)
		}

		if (options.banDir) {
			const before = builder.distinctCount
			const { pairs, rowsWithLieuDit, filesRead, files } = await extractLieuDitPairs(options.banDir)

			banFiles = files

			for (const pair of pairs) {
				builder.addRow(pair.child, pair.parent, pair.parentTag)
			}

			secondaryPairsAdded += builder.distinctCount - before

			console.error(
				`pair-index: +${builder.distinctCount - before} distinct lieu-dit pairs ` +
					`(${filesRead} départements, ${rowsWithLieuDit.toLocaleString()} rows with a clean lieu-dit)`
			)
		}

		if (options.pairsJSONL) {
			for (const path of splitPathList(options.pairsJSONL)) {
				const before = builder.distinctCount

				for await (const pair of JSONSpliterator.fromAsync<{
					child: string
					parent: string
					parentTag?: ComponentTag
				}>(path)) {
					builder.addRow(pair.child, pair.parent, pair.parentTag ?? SOURCE_PARENT_TAGS.secondaryPairsJSONL)
				}

				secondaryPairsAdded += builder.distinctCount - before

				console.error(
					`pair-index: +${builder.distinctCount - before} distinct secondary pairs (${path.split("/").pop()})`
				)
			}
		}

		const built = builder.finish()
		const { rowsKept, rowsSkipped, distribution } = built

		// The holdout deterministically withholds a fraction of pairs so an evaluation can test unseen pairs.
		const { kept: entries, heldOut } = applyPairIndexHoldout(
			built.entries,
			options.holdoutFraction,
			options.holdoutSeed
		)

		// The header records the BAN directory as one MD5 over each département file's name and MD5.
		const banFileDigests: string[] = []

		for (const file of banFiles) {
			banFileDigests.push(`${basename(file)} ${await md5File(file)}`)
		}

		const sourceMD5s = [
			...(sourcePath ? [await md5File(sourcePath)] : []),
			...(options.boroughDB ? [await md5File(options.boroughDB)] : []),
			...(await Promise.all(splitPathList(options.pairsJSONL).map((path) => md5File(path)))),
			...(banFileDigests.length ? [md5Hex(banFileDigests.join("\n"))] : []),
		]

		// An omitted flag writes no header key.
		// The reader treats an absent key as disabled, which differs from an explicit zero.
		const pairIndexHeader: PairIndexHeaderInput = {
			country,
			delta: options.delta,
			foldVersion: 1,
			sourceMD5s,
			buildDate: new Date().toISOString(),
			...(options.transitionBeta !== undefined ? { transitionBeta: options.transitionBeta } : {}),
			...(options.parentDelta !== undefined ? { parentDelta: options.parentDelta } : {}),
		}

		const bytes = serializePairIndex(pairIndexHeader, entries)
		const outPath = PathBuilder.from(options.out)(`pair-index-${country}.bin`)

		await writeLocalFile(bytes, outPath)

		// The probes read the serialized bytes so they also verify serialization.
		const resolver = new PairIndexResolver(bytes)
		const countryProbePairs = PROBE_PAIRS_BY_COUNTRY[country]

		if (!countryProbePairs) {
			throw new Error(
				`pair-index: no self-check probe pairs registered for country "${country}" — add an entry to ` +
					`PROBE_PAIRS_BY_COUNTRY (probing another country's names verifies nothing).`
			)
		}

		const probeLines = countryProbePairs.map(([city, district]) => {
			const child = normalizeFSTToken(city)
			const parent = normalizeFSTToken(district)
			const edge = resolver.probe(child, parent)

			return edge
				? `PROBE OK: fold("${city}")/fold("${district}") → "${child}"/"${parent}" → ${edge.tag} under ${edge.parentTag}`
				: `PROBE MISS: fold("${city}")/fold("${district}") → "${child}"/"${parent}" → (no entry)`
		})

		const distLines = [
			`CITY word-length distribution (raw, pre-fold; n=${distribution.totalRows.toLocaleString()}): ` +
				`p50=${distribution.p50} p90=${distribution.p90} p99=${distribution.p99} max=${distribution.max}`,
			...distribution.counts.map(
				(b) => `  ${b.words} word${b.words === 1 ? "" : "s"}: ${b.rows.toLocaleString()} rows`
			),
		]

		// The cross-check counts pairs before the holdout and is skipped when a holdout is set.
		const preHoldoutCount = built.entries.length
		const preFoldSuffix = ` (pre-fold rung-3 census: ${RUNG3_PRE_FOLD_CENSUS_LINE_COUNT.toLocaleString()} lines)`

		const checkLine =
			country === "gb"
				? options.holdoutFraction > 0
					? `(cross-check skipped under --holdout-fraction; ${preHoldoutCount.toLocaleString()} distinct pairs before holdout, expects ${(EXPECTED_GB_PAIR_COUNT + secondaryPairsAdded).toLocaleString()})${preFoldSuffix}`
					: preHoldoutCount === EXPECTED_GB_PAIR_COUNT + secondaryPairsAdded
						? `CROSS-CHECK PASS: ${preHoldoutCount.toLocaleString()} distinct pairs (baseline ${EXPECTED_GB_PAIR_COUNT.toLocaleString()} + ${secondaryPairsAdded} from secondary sources)${preFoldSuffix}`
						: `CROSS-CHECK BLOCKED: ${preHoldoutCount.toLocaleString()} distinct pairs != baseline ${EXPECTED_GB_PAIR_COUNT.toLocaleString()} + ${secondaryPairsAdded} from secondary sources — investigate fold divergence before trusting this artifact${preFoldSuffix}`
				: country === "us"
					? options.holdoutFraction > 0
						? `(cross-check skipped under --holdout-fraction; ${preHoldoutCount.toLocaleString()} distinct pairs before holdout, expects ${EXPECTED_US_PAIR_COUNT.toLocaleString()})`
						: preHoldoutCount === EXPECTED_US_PAIR_COUNT
							? `CROSS-CHECK PASS: ${preHoldoutCount.toLocaleString()} distinct pairs (all WOF-sourced; no postal register)`
							: `CROSS-CHECK BLOCKED: ${preHoldoutCount.toLocaleString()} distinct pairs != ${EXPECTED_US_PAIR_COUNT.toLocaleString()} — a WOF snapshot refresh moves this number, so re-anchor the constant DELIBERATELY (with the diff inspected) rather than trusting the artifact`
					: `(cross-check only registered for gb/us; ${preHoldoutCount.toLocaleString()} distinct pairs)`

		const holdoutLine =
			options.holdoutFraction > 0
				? `HOLDOUT: withheld ${heldOut.length.toLocaleString()}/${preHoldoutCount.toLocaleString()} pairs ` +
					`(fraction=${options.holdoutFraction}, seed=${options.holdoutSeed}) — ${entries.length.toLocaleString()} pairs written`
				: undefined

		return [
			`pair-index-${country}.bin → ${outPath} (${bytes.length.toLocaleString()} bytes)`,
			`header: delta=${options.delta}` +
				(options.transitionBeta !== undefined ? ` transitionBeta=${options.transitionBeta}` : " (no transitionBeta)") +
				(options.parentDelta !== undefined ? ` parentDelta=${options.parentDelta}` : " (no parentDelta)"),
			`rows kept ${rowsKept.toLocaleString()} / skipped ${rowsSkipped.toLocaleString()} (empty CITY)`,
			`distinct pairs: ${entries.length.toLocaleString()}`,
			...(holdoutLine ? [holdoutLine] : []),
			checkLine,
			...distLines,
			...probeLines,
		]
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

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
