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

import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs"
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
import { extractBoroughPairs } from "../../gazetteer-pipeline/borough-pairs.ts"
import { extractLieuDitPairs } from "../../gazetteer-pipeline/lieudit-pairs.ts"
import { PairIndexBuilder, applyPairIndexHoldout } from "../../gazetteer-pipeline/pair-index.ts"

/**
 * The GB source's adjudicated production distinct-pair count — the cross-check this build must reproduce. Re-anchored
 * (final-review fix) from the rung-3 census's raw 19,431 lines (`scratchpad/gb-probe-grade/census-gb-pairs.jsonl`) down
 * to 19,209. This is not a bug fix — a real Task-3 cross-check rebuild fired the gate at exactly this delta and it was
 * adjudicated as the production fold correctly MERGING punctuation-variant duplicates the raw census counted separately
 * (e.g. "St Helens" vs "St. Helens" fold to the SAME `(child, parent)` key). The collision receipt: 221 merge groups —
 * 220 groups where 2 raw census lines collapse to 1 production entry (220 × 1 collapsed line = 220) plus 1 group where
 * 3 raw lines collapse to 1 entry (1 × 2 collapsed lines = 2) — 220 + 2 = 222 raw lines absorbed; 19,431 − 222 =
 * 19,209. See `.superpowers/sdd/progress.md`'s Task 3 entry for the adjudication record. A mismatch AGAINST 19,209 on a
 * real rebuild means this build's fold diverged from the adjudicated baseline, not that 19,209 is wrong; investigate
 * before trusting the artifact.
 */
const EXPECTED_GB_PAIR_COUNT = 19_209

/**
 * The raw rung-3 census's pre-fold line count (`scratchpad/gb-probe-grade/census-gb-pairs.jsonl`) — retained as a named
 * constant for provenance/debugging (e.g. diffing a future source refresh against this cycle's raw count), NOT the
 * cross-check target. See {@link EXPECTED_GB_PAIR_COUNT}'s doc comment for why the production target is lower.
 */
const RUNG3_PRE_FOLD_CENSUS_LINE_COUNT = 19_431

/**
 * The US instance's cross-check (hierarchy campaign R5), measured 2026-08-01 against the shipped
 * `admin-global-priority.db`. Unlike GB there is no postal register in the mix — every pair is WOF-sourced (borough +
 * neighbourhood children under locality/localadmin/borough parents, see `PAIR_PLACETYPES_BY_COUNTRY`), so this number
 * tracks the WOF snapshot alone. A snapshot refresh legitimately moves it; re-anchor the constant deliberately, after
 * inspecting the diff, rather than relaxing the gate.
 */
const EXPECTED_US_PAIR_COUNT = 47_878

/**
 * Known (child, parent) pairs probed after write as a self-check — PER COUNTRY, keyed by the `--country` code. Probing
 * another country's names against a freshly built index prints reassuring-looking `PROBE MISS` lines that verify
 * nothing (the en-nz first build ran the GB names — caught 2026-07-24). A country without an entry gets a loud skip,
 * not a false verification.
 */
const PROBE_PAIRS_BY_COUNTRY: Readonly<Record<string, ReadonlyArray<readonly [city: string, district: string]>>> = {
	gb: [
		["Fishburn", "Stockton-on-Tees"],
		["Shoreditch", "London"],
		["Sedgefield", "Stockton-on-Tees"],
	],
	nz: [
		["Plimmerton", "Porirua"],
		// The repeated-name convention's identity pair — the (x,x) evidence the segment rule keys on.
		["Mangawhai", "Mangawhai"],
	],
	// R5 (hierarchy campaign): the US instance's probes. Unlike GB/NZ these are NOT postal-format
	// dependent localities — USPS routes city/state/ZIP — they are the borough/neighbourhood class
	// the schema's umbrella term covers, sourced from WOF rather than a postal register.
	us: [
		["Astoria", "Queens"],
		["Park Slope", "Brooklyn"],
		["Manhattan", "New York"],
	],
	// R10: the IN instance. Indian addresses carry an area/locality line above the city
	// ("Indiranagar, Bengaluru"), which is the dependent-locality slot.
	in: [
		["Indiranagar", "Bangalore"],
		["Mulund East", "Mumbai"],
	],
	// R9: the DE instance. Ortsteile/Stadtteile under their Gemeinde — the line German addresses
	// carry when they carry one at all (the Ortsteil sits above "PLZ Stadt", never inside it).
	de: [
		["Nippes", "Köln"],
		["Schwabing", "München"],
	],
	// R6: the FR instance. These are LIEUX-DITS under their communes (BAN `nom_ld`), not quartiers —
	// see gazetteer-pipeline/lieudit-pairs.ts for why the French source differs from the US one.
	fr: [
		["Pinsonnac", "Montpeyroux"],
		["Line", "Salignac-Eyvigues"],
	],
}

/**
 * Split a comma-separated path list, tolerating whitespace and an absent value. Each secondary source stays its OWN
 * file rather than being pre-merged into a blob, so every one keeps a distinct provenance md5 in the header — which is
 * what lets a freshness guard notice that exactly one of them changed.
 */
function splitPathList(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((path) => path.trim())
		.filter(Boolean)
}

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
	transitionBeta: zod
		.number()
		.optional()
		.describe(
			"OPTIONAL — the decoder transition-entry bonus a probe hit contributes (+β into B-<tag> at the child's " +
				"first piece; TRANSITION-BETA build, task-8 probe). Written into the PIX1 header ONLY when passed — " +
				"omitting it builds a beta-less artifact (no transition term at decode, the pre-beta behavior). " +
				"Per-country calibration like --delta: GB ships 5; NZ ships without it."
		),
	holdoutFraction: zod
		.number()
		.min(0)
		.max(1)
		.default(0)
		.describe(
			"DEV-ONLY falsifier flag (placetype-pair-prior arc, Task 6) — withhold this fraction of deduplicated pairs " +
				"from the build (seeded, deterministic; see --holdout-seed), for measuring decode-layer degradation " +
				"against pairs the index was never trained/built on. Default 0 = a normal, complete build. NEVER pass a " +
				"nonzero value for a shipped artifact build."
		),
	pairsJsonl: zod
		.string()
		.optional()
		.describe(
			"Secondary pairs JSONL ({child, parent} per line) merged through the same fold — hierarchy campaign R3 (ONSPD London wards etc.)"
		),
	boroughDb: zod
		.string()
		.optional()
		.describe("WOF admin DB path — merge borough (child, parent) pairs for the country (hierarchy campaign R2)"),
	banDir: zod
		.string()
		.optional()
		.describe(
			"BAN adresses-<dept>.csv directory — merge FR (lieu-dit, commune) pairs through ban/sdk's cleanLieuDit filter (hierarchy campaign R6)"
		),
	holdoutSeed: zod
		.number()
		.default(42)
		.describe("Seed for --holdout-fraction's deterministic withholding. Ignored when --holdout-fraction is 0."),
})

export { OptionsSchema as options }

const GazetteerPairIndex: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const country = options.country.toLowerCase()
		// The PPD tuples CSV is a GB national register — there is no equivalent for the US instance (USPS routes
		// city/state/ZIP, so no postal source carries dependent localities). A country whose pairs come entirely from
		// the WOF/secondary sources below runs with NO CSV rather than being handed an empty one.
		const sourcePath =
			options.source ?? (country === "gb" ? String(dataRootPath("ppd", "2026-07-22", "gb-tuples.csv")) : undefined)

		if (sourcePath && !existsSync(sourcePath)) {
			throw new Error(`pair-index: source CSV not found: ${sourcePath}`)
		}

		if (!sourcePath && !options.boroughDb && !options.pairsJsonl && !options.banDir) {
			throw new Error(
				`pair-index: country "${country}" has no PPD default — pass --source, --borough-db, --pairs-jsonl or --ban-dir, ` +
					`or the build would write an empty index.`
			)
		}

		const builder = new PairIndexBuilder()
		let header: string[] | null = null
		let cityIx = -1
		let districtIx = -1

		// Same CSVSpliterator idiom as `corpus/src/shard-recipes/locale.ts`'s `readTuples`: array mode, no header
		// row consumed by the parser (`header: false`), so we build the column index off the first yielded row
		// ourselves and skip forward from there.
		if (sourcePath) {
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
		}

		// R2 (hierarchy campaign): borough pairs from the WOF admin DB, through the SAME fold/dedupe
		// as the CSV rows (boroughs project onto dependent_locality — plan/reference/placetype-evidence).
		let boroughsAdded = 0

		if (options.boroughDb) {
			const before = builder.distinctCount

			for (const pair of extractBoroughPairs(options.boroughDb, country.toUpperCase())) {
				builder.addRow(pair.child, pair.parent)
			}

			boroughsAdded = builder.distinctCount - before

			console.error(`pair-index: +${boroughsAdded} distinct borough pairs (WOF admin DB)`)
		}

		// R6: FR lieu-dit pairs from the raw BAN dump. Streams ~26M rows, so it is the slowest source by far —
		// deliberately opt-in per build rather than a default.
		if (options.banDir) {
			const before = builder.distinctCount
			const { pairs, rowsWithLieuDit, filesRead } = await extractLieuDitPairs(options.banDir)

			for (const pair of pairs) {
				builder.addRow(pair.child, pair.parent)
			}

			boroughsAdded += builder.distinctCount - before

			console.error(
				`pair-index: +${builder.distinctCount - before} distinct lieu-dit pairs ` +
					`(${filesRead} départements, ${rowsWithLieuDit.toLocaleString()} rows with a clean lieu-dit)`
			)
		}

		// R3: generic secondary pairs (ONSPD-derived London ward pairs; future NI/IE sources) — the
		// same fold/dedupe path, counted into the cross-check delta alongside the boroughs.
		if (options.pairsJsonl) {
			for (const path of splitPathList(options.pairsJsonl)) {
				const before = builder.distinctCount

				for (const line of readFileSync(path, "utf8").split("\n")) {
					if (!line.trim()) continue

					const pair = JSON.parse(line) as { child: string; parent: string }

					builder.addRow(pair.child, pair.parent)
				}

				boroughsAdded += builder.distinctCount - before

				console.error(
					`pair-index: +${builder.distinctCount - before} distinct secondary pairs (${path.split("/").pop()})`
				)
			}
		}

		const built = builder.finish()
		const { rowsKept, rowsSkipped, distribution } = built

		// Task 6 falsifier-board dev flag: withhold a deterministic fraction of pairs from the build so a
		// downstream eval can measure decode-layer degradation on pairs the index never saw. A no-op
		// (`entries === built.entries` by value) when --holdout-fraction is the 0 default.
		const { kept: entries, heldOut } = applyPairIndexHoldout(
			built.entries,
			options.holdoutFraction,
			options.holdoutSeed
		)

		// Provenance covers every source that contributed rows, in the order they were folded in — a US build has no
		// CSV at all, so an unconditional single-element array would have claimed a source the artifact never read.
		const sourceMD5s = [
			...(sourcePath ? [await md5File(sourcePath)] : []),
			...(options.boroughDb ? [await md5File(options.boroughDb)] : []),
			...(await Promise.all(splitPathList(options.pairsJsonl).map((path) => md5File(path)))),
		]

		// `transitionBeta` is spread conditionally so an omitted flag writes NO header key at all (a
		// beta-less binary, byte-shape-identical to every pre-TRANSITION-BETA artifact) — not a null/0.
		const pairIndexHeader: PairIndexHeader = {
			country,
			delta: options.delta,
			schemaVersion: 1,
			foldVersion: 1,
			sourceMD5s,
			buildDate: new Date().toISOString(),
			...(options.transitionBeta !== undefined ? { transitionBeta: options.transitionBeta } : {}),
		}

		const bytes = serializePairIndex(pairIndexHeader, entries)
		const outPath = join(options.out, `pair-index-${country}.bin`)

		writeFileSync(outPath, bytes)

		// Self-verifying readback: construct a fresh resolver over the bytes we just wrote (not the in-memory
		// `entries`) and probe known pairs, rather than trusting the write silently succeeded.
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

		// The rung-3 cross-check assumes a COMPLETE build — a nonzero --holdout-fraction deliberately produces a
		// smaller `entries.length` by design, so the strict count-match gate is meaningless (and would misreport
		// "BLOCKED") under holdout. Gate against `built.entries.length` (pre-holdout) instead in that case.
		const preHoldoutCount = built.entries.length
		// Pre-fold context suffix — the raw rung-3 census line count, for provenance/debugging (e.g. diffing a
		// future source refresh against this cycle's raw count). Not the cross-check target; see
		// `EXPECTED_GB_PAIR_COUNT`'s doc comment for the 221-group collision receipt that separates the two numbers.
		const preFoldSuffix = ` (pre-fold rung-3 census: ${RUNG3_PRE_FOLD_CENSUS_LINE_COUNT.toLocaleString()} lines)`

		const gateLine =
			country === "gb"
				? options.holdoutFraction > 0
					? `(cross-check skipped under --holdout-fraction; ${preHoldoutCount.toLocaleString()} distinct pairs before holdout, expects ${(EXPECTED_GB_PAIR_COUNT + boroughsAdded).toLocaleString()})${preFoldSuffix}`
					: preHoldoutCount === EXPECTED_GB_PAIR_COUNT + boroughsAdded
						? `CROSS-CHECK PASS: ${preHoldoutCount.toLocaleString()} distinct pairs (baseline ${EXPECTED_GB_PAIR_COUNT.toLocaleString()} + ${boroughsAdded} borough)${preFoldSuffix}`
						: `CROSS-CHECK BLOCKED: ${preHoldoutCount.toLocaleString()} distinct pairs != baseline ${EXPECTED_GB_PAIR_COUNT.toLocaleString()} + ${boroughsAdded} borough — investigate fold divergence before trusting this artifact${preFoldSuffix}`
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
				(options.transitionBeta !== undefined ? ` transitionBeta=${options.transitionBeta}` : " (no transitionBeta)"),
			`rows kept ${rowsKept.toLocaleString()} / skipped ${rowsSkipped.toLocaleString()} (empty CITY)`,
			`distinct pairs: ${entries.length.toLocaleString()}`,
			...(holdoutLine ? [holdoutLine] : []),
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
