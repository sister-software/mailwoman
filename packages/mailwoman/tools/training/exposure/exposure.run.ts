/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Writes the exposure measurement artifact (`mailwoman.exposure/v1`) for one set of inputs.
 *
 *   `--canonical` measures the `canonical_rows` stage over canonical JSONL files, compressed or not. `--config`
 *   measures `eligible_training_rows` over the config's `train` split and `replayed_draws` over epoch 1 of its
 *   mixture, at the trainer's seed `train.seed + 1`. A stage whose input is not given is written as `null`. The
 *   corpus is read through the `mtf-node` addon, so a config's `/data` paths are its host copies under
 *   `$MAILWOMAN_DATA_ROOT`, or a copy of the config states host paths.
 *
 *   Usage:
 *     node packages/mailwoman/tools/training/exposure/exposure.run.ts \
 *       --canonical <staging>/osm/canonical.jsonl \
 *       --source-stats RU=$MAILWOMAN_DATA_ROOT/db/osm/corpus/osm-ru.corpus.jsonl.stats.json \
 *       --config <config>.yaml [--countries RU,KZ] [--draws <n>] [--replay-only] --json exposure.json
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { asPythonFloat } from "@mailwoman/core/strings/python-json"
import type { TrainingConfig } from "@mailwoman/corpus/training/config/schema"
import { mtfNode, type MTFNode, type SampledRow } from "@mailwoman/mtf/tools/sampler/native"
import type { LabelSetName } from "@mailwoman/neural/labels"
import { labelSetContract } from "@mailwoman/neural/semantic-tags"
import { readAddressSystemRegistry } from "@mailwoman/neural/tools/address-system-registry"

import { drawnRows } from "../audits/census.ts"
import { resolveSourceWeights } from "../audits/epoch-mixture.ts"
import { writeAuditReport } from "../audits/receipt.ts"
import { loadTrainingConfig } from "../config.ts"
import { samplerConfigJSON } from "../sampler.ts"
import {
	addressSystemLookup,
	buildReport,
	codeRevision,
	countCanonicalJSONL,
	rowCountry,
	measuredAt,
	numericShapePairs,
	StageCounter,
	type SpanRecord,
} from "./report.ts"

const { values } = parseArguments({
	options: {
		canonical: { type: "string", multiple: true, default: [] },
		"source-stats": { type: "string", multiple: true, default: [] },
		config: { type: "string" },
		countries: { type: "string" },
		draws: { type: "string" },
		"corpus-version": { type: "string" },
		"replay-only": { type: "boolean", default: false },
		json: { type: "string" },
	},
})

if (!values.json) throw new Error("--json is required")

/**
 * Parses JSON keeping a number written with a fraction or an exponent as a Python float,
 * so a stats file's values are written back as `json.dumps` wrote them.
 */
function parsePythonJSON(text: string): unknown {
	// oxlint-disable-next-line no-restricted-properties -- `parseJSONStrict` takes no reviver, and the reviver reads each number's source text.
	return JSON.parse(text, (_key, value, context?: { source?: string }) =>
		typeof value === "number" && context?.source && /[.eE]/.test(context.source) ? asPythonFloat(value) : value
	)
}

/**
 * The `source_records` stage per jurisdiction, read from each acquisition's stats file.
 */
async function sourceStats(entries: readonly string[]): Promise<Map<string, Map<string, unknown>>> {
	const out = new Map<string, Map<string, unknown>>()

	for (const entry of entries) {
		const separator = entry.indexOf("=")
		const [country, path] = separator === -1 ? [entry, ""] : [entry.slice(0, separator), entry.slice(separator + 1)]
		const stats = parsePythonJSON(await readLocalTextFile(path)) as Record<string, unknown>
		const extract = (stats["extract"] ?? null) as Record<string, Record<string, unknown>> | null
		const layers = extract ? Object.values(extract) : []

		const matched = layers.length
			? layers.reduce((sum, layer) => sum + ((layer["matched"] as number | undefined) ?? 0), 0)
			: null

		out.set(
			country.toUpperCase(),
			new Map<string, unknown>([
				["total", matched ?? stats["read"] ?? null],
				["read", stats["read"] ?? null],
				["written", stats["written"] ?? null],
				["without_street", stats["noStreet"] ?? null],
				["extract", layers.length ? extract : null],
				["stats_path", path],
				["receipt", stats["receipt"] ?? null],
			])
		)
	}

	return out
}

/**
 * Every train-split row whose country and source the config weights above zero, in file and row order.
 */
function* eligibleRows(
	mtf: MTFNode,
	config: TrainingConfig,
	countries: ReadonlySet<string> | null
): Generator<SpanRecord> {
	const countryWeights = config.data.country_weights
	const { weights } = resolveSourceWeights(mtf, config, config.data.corpus_dir)
	const sourceWeights = weights ? new Map(weights) : null

	const admitted = new Set(
		Object.entries(countryWeights)
			.filter(([country, weight]) => weight > 0 && (countries == null || countries.has(country)))
			.map(([country]) => country)
	)

	const columns = ["raw", "country", "source", "span_starts", "span_ends", "span_tags"]

	// The addon drops every row outside the admitted countries before converting a column to JavaScript.
	const reader = new mtf.SplitColumns(samplerConfigJSON(config), "train", columns, {
		column: "country",
		values: [...admitted],
	})

	for (let chunk = reader.nextChunk(); chunk; chunk = reader.nextChunk()) {
		const raw = chunk.strings["raw"] ?? []
		const country = chunk.strings["country"] ?? []
		const source = chunk.strings["source"] ?? []
		const starts = chunk.intLists["span_starts"] ?? []
		const ends = chunk.intLists["span_ends"] ?? []
		const tags = chunk.lists["span_tags"] ?? []

		for (let i = 0; i < chunk.rows; i++) {
			const code = country[i]

			if (code == null || !admitted.has(code.toUpperCase())) continue

			const key = rowCountry(code)

			if (countries != null && !countries.has(key)) continue

			if (!((countryWeights[key] ?? 0) > 0)) continue

			const rowSource = source[i]

			if (sourceWeights != null && !(rowSource != null && (sourceWeights.get(rowSource) ?? 0) > 0)) continue

			yield { raw: raw[i], country: code, spanStarts: starts[i], spanEnds: ends[i], spanTags: tags[i] }
		}
	}
}

/**
 * A sampled row as the counter reads it.
 */
function spanRecord(row: SampledRow): SpanRecord {
	return {
		raw: row.raw,
		country: row.country,
		spanStarts: row.spanStarts,
		spanEnds: row.spanEnds,
		spanTags: row.spanTags,
	}
}

const mtf = await mtfNode()
const registry = await readAddressSystemRegistry()

if (!registry) throw new Error("the address-system registry is missing; run `mailwoman dev generate address-systems`")

const addressSystem = addressSystemLookup(registry, mtf.pythonText)

const counter = (stage: ConstructorParameters<typeof StageCounter>[0]) =>
	new StageCounter(stage, addressSystem, mtf.pythonText)

const counters: StageCounter[] = []
const inputs = new Map<string, string>()

if (values.canonical.length) {
	counters.push(await countCanonicalJSONL(counter("canonical_rows"), values.canonical))
	inputs.set("canonical_rows", values.canonical.join(", "))
}

let labelSet = null

if (values.config) {
	const config = await loadTrainingConfig(values.config)

	const countries = values.countries
		? new Set(values.countries.split(",").map((code) => code.trim().toUpperCase()))
		: null

	labelSet = labelSetContract((config.data.label_set ?? "stage3") as LabelSetName)

	if (!values["replay-only"]) {
		const eligible = counter("eligible_training_rows")

		for (const record of eligibleRows(mtf, config, countries)) {
			eligible.addSpanRow(record)
		}

		counters.push(eligible)
	}

	const draws = (values.draws ? Number(values.draws) : 0) || config.data.train_rows_per_epoch

	if (draws) {
		const replayed = counter("replayed_draws")

		for (const row of drawnRows(mtf, config, { seed: config.train.seed + 1, draws })) {
			if (countries == null || countries.has(rowCountry(row.country))) {
				replayed.addSpanRow(spanRecord(row))
			}
		}

		counters.push(replayed)
	}

	inputs.set("corpus_dir", config.data.corpus_dir)
}

const pairs = values.canonical.length
	? new Map<string, unknown>([
			["numeric-shape-across-contexts", new Map([["canonical_rows", numericShapePairs(counters[0]!)]])],
			// Each OSM object yields one rendering, so no canonical row has a second-script twin.
			[
				"ordering-reverses-with-script",
				new Map<string, unknown>([
					["canonical_rows", new Map([["paired_examples", 0]])],
					["basis", "the OSM adapter emits one rendering per object"],
				]),
			],
		])
	: null

const sourceRecords = await sourceStats(values["source-stats"])

const report = buildReport(counters, {
	sourceRecords: sourceRecords.size ? sourceRecords : null,
	pairs,
	corpusVersion: values["corpus-version"] ?? null,
	trainingConfig: values.config ?? null,
	labelSet,
	inputs,
	codeRevision: await codeRevision(),
	measuredAt: measuredAt(),
	registry,
})

await writeAuditReport(values.json, report, { ensureASCII: false, trailingNewline: true })
