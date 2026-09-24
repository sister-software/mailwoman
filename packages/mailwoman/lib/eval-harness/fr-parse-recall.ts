/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Compare French street recall with and without postcode context using OSM addresses.
 *   This is the promotion battery leg for the `fr.bare_street_intact` floor.
 *   Run through `packages/mailwoman/lib/dev-tools/fr/parse-recall.run.ts`.
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

/**
 * The frozen 40-row OSM sample the bare-street floor is graded on.
 *
 * A package sibling, so the same file is named from the source tree and from `out/`.
 */
const FR_BARE_STREET_FIXTURE_PATH = resolvePackagePath(
	"mailwoman",
	"lib",
	"eval-harness",
	"fixtures",
	"fr-bare-street-40.jsonl"
)

/**
 * Maximum bare-street failures shown in the report.
 */
const MAX_REPORTED_FAILURES = 12

/**
 * Resolve a weights sibling, preferring candidate, data-root, then package paths.
 *
 * Throws with attempted paths; missing artifacts must not become misleading scores.
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
	 * Candidate ONNX and tokenizer paths; otherwise use installed weights.
	 *
	 * Candidate runs also load model-independent sibling artifacts.
	 */
	model?: string
	tokenizer?: PathBuilderLike
	/**
	 * Default `neural-weights-en-us/model-card.json`.
	 */
	modelCard?: string
	/**
	 * Optional label printed in the `[pair]` provenance line.
	 */
	label?: string
	/**
	 * Frozen fixture used by the promotion leg, including in database-free CI.
	 */
	fixture?: string
	/**
	 * Rebuild the fixture from the live OSM database.
	 */
	fromDB?: boolean
	/**
	 * Emit machine-readable rates to this path for `promotion-eval.ts`.
	 */
	json?: string
	/**
	 * Candidate weights root for resolving its anchor and lexicon siblings.
	 */
	weightsCache?: string
	/**
	 * Optional minimum bare-intact rate, in percent.
	 */
	floor?: string
}

/**
 * Parse-recall rates and optional floor verdict.
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
 * Measure the FR bare-vs-anchored street parse-recall delta and enforce the `fr.bare_street_intact` floor.
 *
 * The report lines go to `report` and the `fail` line to `reportError`,
 * mirroring the stdout/stderr split the check captured.
 * It wrote `${stdout}${stderr}` into `fr-bare-street.md`, so the two sinks stay separate
 * and are concatenated in that order.
 *
 * The floor verdict comes back as {@linkcode FRParseRecallResult.pass} instead of the old `process.exit(1)`.
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

				// Distinct streets with a city + postcode, sampled across the table (not one street repeated).
				// Deterministic (group BY + order BY, no random) — the same database yields the same 40 rows.
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
		// snake_case wire keys, 2-space indent, trailing newline.
		// The sidecar shape is a interface with whatever reads it next.
		// The migration keeps it byte-for-byte.
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
