/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { walkNodes } from "@mailwoman/core/decoder"
import { pathExists, readLocalBuffer, readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict, prettyJSON } from "@mailwoman/core/json"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { workspacePath } from "@mailwoman/core/paths"
import { allRows } from "@mailwoman/core/utils"
import { NeuralAddressClassifier, parseGazetteerLexicon, PostcodeBinaryResolver } from "@mailwoman/neural"
import { ONNXRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import type { OSMAddressPointDatabase } from "@mailwoman/osm/sdk/address-point-schema"
import { normalizeStreetForKeyLocale } from "@mailwoman/resolver-wof-sqlite/street"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"
import { TextSpliterator } from "spliterator"

const STREET_TAGS = new Set(["street", "street_prefix", "street_suffix"])

const FR_BARE_STREET_FIXTURE_PATH = resolvePackagePath(
	"mailwoman",
	"lib",
	"eval-harness",
	"fixtures",
	"fr-bare-street-40.jsonl"
)

const MAX_REPORTED_FAILURES = 12

/**
 * Returns the first existing copy of a weights file from the candidate cache,
 * the data root, or the workspace.
 */
async function resolveWeightsSibling(fileName: string, weightsCache?: string): Promise<PathBuilderLike> {
	const candidates = [
		...(weightsCache ? [`${weightsCache}/node_modules/@mailwoman/neural-weights-en-us/${fileName}`] : []),
		dataRootPath("weights", "en-us", fileName),
		workspacePath("neural-weights-en-us", fileName),
	]

	const existing = await Promise.all(candidates.map(async (path) => ({ path, exists: await pathExists(path) })))
	const found = existing.find((entry) => entry.exists)?.path

	if (!found) {
		throw new Error(
			`fr-parse-recall: cannot locate ${fileName}. Tried, in order:\n  ${candidates.join("\n  ")}\n` +
				"On a dev checkout this comes from the data-root overlay — run the en-us link-dev-weights script. " +
				"This is a MISSING ARTIFACT, not a French parse regression; do not read it as the bare-street floor."
		)
	}

	return found
}

/**
 * Options for {@linkcode frParseRecall}.
 */
export interface FRParseRecallOptions {
	/**
	 * Candidate ONNX model path.
	 *
	 * It takes effect only when `tokenizer` is also set.
	 * Otherwise the installed en-US weights load.
	 *
	 * A candidate run also loads the postcode anchor and gazetteer lexicon from the weights directory.
	 */
	model?: string
	tokenizer?: PathBuilderLike

	/**
	 * Model card that supplies the candidate's labels.
	 *
	 * It defaults to `packages/neural-weights-en-us/model-card.json`.
	 */
	modelCard?: string

	/**
	 * Label for the `[pair]` provenance line.
	 * An empty label omits the line.
	 */
	label?: string

	/**
	 * JSONL fixture of French bare-street rows.
	 * It defaults to the bundled `fr-bare-street-40.jsonl`.
	 */
	fixture?: string

	/**
	 * Whether to read rows from the local French OSM address-point database instead of the fixture.
	 */
	fromDB?: boolean

	/**
	 * Path where the intact counts and rates are written as JSON.
	 */
	json?: string

	/**
	 * Candidate weights root that is searched first for the anchor and lexicon files.
	 */
	weightsCache?: string

	/**
	 * Minimum bare-street intact rate in percent, given as a numeric string.
	 */
	floor?: string
}

/**
 * Parse-recall counts, rates in percent, and the floor verdict.
 * The verdict `pass` is true when no floor is set.
 */
export interface FRParseRecallResult {
	bareIntact: number
	anchoredIntact: number
	n: number
	bareRate: number
	anchoredRate: number
	source: string
	pass: boolean
}

interface FRRow {
	street_raw: string
	number: string
	locality_norm: string
	postcode: string
}

interface StreetKeyNode {
	tag: string
	value: string
	start: number
	children: readonly StreetKeyNode[]
}

/**
 * Joins the street nodes of a parse in input order and normalizes the result as a French street key.
 */
function streetKeyOf(tree: { roots: readonly StreetKeyNode[] }): string {
	const parts: Array<{ value: string; start: number }> = []

	for (const n of walkNodes(tree.roots)) {
		if (STREET_TAGS.has(n.tag) && n.value.trim()) {
			parts.push({ value: n.value.trim(), start: n.start })
		}
	}

	parts.sort((a, b) => a.start - b.start)

	return normalizeStreetForKeyLocale(parts.map((p) => p.value).join(" "), "fr")
}

/**
 * Measures how often French street names survive parsing with and without a postcode.
 *
 * When `options.floor` is set, it also checks the bare rate against that floor.
 *
 * The verdict is returned in {@linkcode FRParseRecallResult.pass}.
 * Only the failure line goes to `reportError`.
 */
export async function frParseRecall(
	options: FRParseRecallOptions = {},
	report: (line: string) => void = console.log,
	reportError: (line: string) => void = console.error
): Promise<FRParseRecallResult> {
	const args = {
		modelCard: options.modelCard ?? "packages/neural-weights-en-us/model-card.json",
		label: options.label ?? "",
		fixture: options.fixture ?? FR_BARE_STREET_FIXTURE_PATH,
		fromDB: options.fromDB ?? false,
		model: options.model,
		tokenizer: options.tokenizer,
		json: options.json,
		floor: options.floor,
	}

	const rows: FRRow[] = args.fromDB
		? (() => {
				const db = new DatabaseClient<OSMAddressPointDatabase>(`${dataRootPath()}/osm/address-points-fr-fr.db`, {
					readOnly: true,
				})

				return allRows<FRRow>(
					db.prepare(
						`SELECT street_raw, number, locality_norm, postcode FROM address_point
						 WHERE locality_norm IS NOT NULL AND postcode IS NOT NULL AND street_raw LIKE '% %'
						 GROUP BY street_norm ORDER BY number LIMIT 40`
					)
				)
			})()
		: [...TextSpliterator.from(await readLocalTextFile(args.fixture))]
				.filter((l) => l.trim())
				.map((l) => parseJSONStrict<FRRow>(l))

	const classifier = await (async (): Promise<NeuralAddressClassifier> => {
		if (!args.model || !args.tokenizer) return NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })

		const card = await readLocalJSONFile<{ labels: string[] }>(args.modelCard)

		const anchor = new PostcodeBinaryResolver(
			await readLocalBuffer(await resolveWeightsSibling("postcode-us.bin", options.weightsCache))
		).toAnchorLookup()

		const lexiconPath = await resolveWeightsSibling("anchor-lexicon-v1.json", options.weightsCache)
		const lexicon = parseGazetteerLexicon(await readLocalJSONFile(lexiconPath))

		const [tokenizer, runner] = await Promise.all([
			MailwomanTokenizer.loadFromFile(args.tokenizer),
			ONNXRunner.create(args.model),
		])

		return new NeuralAddressClassifier({
			tokenizer,
			runner,
			labels: card.labels,
			postcodeAnchorLookup: anchor,
			gazetteerLexicon: lexicon,
			suppressGazetteerNearPostcode: true,
			addressSystemConventions: "auto",
			bridgePunctuationGaps: true,
		})
	})()

	if (args.label) {
		report(`[pair] ${args.label}: model=${args.model ?? "package"} tokenizer=${args.tokenizer ?? "package"}`)
	}

	let bareOk = 0
	let anchoredOk = 0
	const fails: string[] = []

	for (const r of rows) {
		const want = normalizeStreetForKeyLocale(r.street_raw, "fr")
		const bareQ = `${r.number} ${r.street_raw}, ${r.locality_norm}`
		const anchQ = `${r.number} ${r.street_raw}, ${r.postcode} ${r.locality_norm}`
		const bare = streetKeyOf(await classifier.parse(bareQ, { postcodeRepair: true, normalizeCase: true }))
		const anch = streetKeyOf(await classifier.parse(anchQ, { postcodeRepair: true, normalizeCase: true }))

		if (bare === want) {
			bareOk++
		}

		if (anch === want) {
			anchoredOk++
		}

		if (bare !== want && fails.length < MAX_REPORTED_FAILURES) {
			fails.push(`  ✗ bare "${r.street_raw}" → "${bare}" (want "${want}")  | anchored→"${anch}"`)
		}
	}

	report(`\nFR street parse-recall on ${rows.length} real OSM addresses:`)

	report(
		`  BARE     (no postcode): ${bareOk}/${rows.length} streets intact  (${((bareOk / rows.length) * 100).toFixed(0)}%)`
	)

	report(
		`  ANCHORED (w/ postcode): ${anchoredOk}/${rows.length} streets intact  (${((anchoredOk / rows.length) * 100).toFixed(0)}%)`
	)

	report(`\nbare failures:`)

	for (const f of fails) {
		report(f)
	}

	const bareRate = (bareOk / rows.length) * 100
	const anchoredRate = (anchoredOk / rows.length) * 100
	const source = args.fromDB ? "live-database" : args.fixture

	if (args.json) {
		await writeLocalTextFile(
			prettyJSON({
				bare_intact: bareOk,
				anchored_intact: anchoredOk,
				n: rows.length,
				bare_rate: Number(bareRate.toFixed(1)),
				anchored_rate: Number(anchoredRate.toFixed(1)),
				source,
			}),
			args.json
		)
	}

	const result: FRParseRecallResult = {
		bareIntact: bareOk,
		anchoredIntact: anchoredOk,
		n: rows.length,
		bareRate: Number(bareRate.toFixed(1)),
		anchoredRate: Number(anchoredRate.toFixed(1)),
		source,
		pass: true,
	}

	if (args.floor !== undefined) {
		const floor = Number(args.floor)

		if (bareRate < floor) {
			reportError(
				`\n✗ fr.bare_street_intact FAIL: ${bareRate.toFixed(1)}% < floor ${floor}% (${bareOk}/${rows.length})`
			)

			return { ...result, pass: false }
		}

		report(`\n✓ fr.bare_street_intact PASS: ${bareRate.toFixed(1)}% ≥ floor ${floor}% (${bareOk}/${rows.length})`)
	}

	return result
}
