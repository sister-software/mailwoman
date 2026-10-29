/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The training sampler for TypeScript tools: a resolved training config turned into the sampler's JSON
 *   configuration, the row and batch streams of the `mtf-node` addon, and the model inputs one batch encodes to.
 *
 *   `samplerConfigJSON` writes the document `sampler_config` in `corpus-python/src/mailwoman_train/data/loader/encode.py`
 *   writes, except that it hands the sampler `source_reps` with the run length rather than weights folded in
 *   beforehand: `mtf-sampler` folds them with the same row counts and the same derivation. `encodeBatch` adds each
 *   row's locale and address-system ids to the row encoder's arrays, as `encode_rows` in `data/loader/batch.py` does.
 */

import { isLatinScriptText } from "@mailwoman/codex/address/format"
import { sha256Hex } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { repoRootPath, workspacePath } from "@mailwoman/core/paths"
import { pythonJSONDumps } from "@mailwoman/core/strings/python-json"
import { $public } from "@mailwoman/corpus/env"
import type { TrainingConfig } from "@mailwoman/corpus/training/config/schema"
import type {
	EncodedRows,
	MTFNode,
	NativeRawRows,
	NativeSampler,
	NativeStreamOptions,
	NativeRowEncoder,
	SampledRow,
	SamplerEvent,
} from "@mailwoman/mtf/tools/sampler/native"
import { IGNORE_INDEX, LOCALE_COUNTRIES, STAGE3_TAGS } from "@mailwoman/neural/labels"
import { readAddressSystemRegistry } from "@mailwoman/neural/tools/address-system-registry"

/**
 * A file under the Python training package's data, which the sampler
 * and encoder read until the package moves.
 */
export function trainingPackagePath(...segments: string[]): string {
	return repoRootPath("corpus-python", "src", "mailwoman_train", ...segments)
}

/**
 * The postcode-shape record the shaped anchor and the postcode finders compile.
 */
export const POSTCODE_SHAPES_PATH = trainingPackagePath("features", "postcode-shapes.json")

/**
 * Each country's postcode syntax, which the postcode finders accept a value against.
 */
export const POSTCODE_SYNTAX_PATH = trainingPackagePath("data", "postcode-syntax.json")

/**
 * Each country's postcode side relative to its locality-and-region block, which the postcode move reads.
 */
export const POSTCODE_LAYOUTS_PATH = trainingPackagePath("data", "augment", "postcode-layouts.json")

/**
 * The label schema `packages/neural/tools/emit-label-schema.run.ts` writes from the TypeScript label sets.
 */
export const LABEL_SCHEMA_PATH = workspacePath("neural", "data", "label-schema.v1.json")

/**
 * The augmentations, by the name each `augment_<name>_prob` field and the sampler's `augment` key give it.
 */
export const AUGMENTATIONS = [
	"directional",
	"region",
	"glue",
	"case",
	"punct_drop",
	"upper_case",
	"ordinal",
	"postcode_move",
	"grouping",
] as const

export type Augmentation = (typeof AUGMENTATIONS)[number]

export type AugmentProbabilities = Record<Augmentation, number>

/**
 * A config's `data` section as the augmentation probabilities the trainer applies.
 */
export function configAugment(data: TrainingConfig["data"]): AugmentProbabilities {
	return Object.fromEntries(
		AUGMENTATIONS.map((name) => [name, data[`augment_${name}_prob` as keyof typeof data] as number])
	) as AugmentProbabilities
}

/**
 * The host copy of a path under the training volume's mount, or `null` when the path is outside the mount.
 */
export function volumePathOnHost(path: string): string | null {
	const mount = $public.MAILWOMAN_VOLUME_MOUNT.replace(/\/+$/, "")

	if (path !== mount && !path.startsWith(`${mount}/`)) return null

	return `${$public.MAILWOMAN_DATA_ROOT.replace(/\/+$/, "")}${path.slice(mount.length)}`
}

/**
 * A config path under the volume mount, rewritten to its host copy.
 */
export function hostPath(path: string): string {
	return volumePathOnHost(path) ?? path
}

/**
 * What a sampler document takes beyond the config.
 */
export interface SamplerConfigOptions {
	/**
	 * Removes each row's span triple before the astral check: the encoder takes the token-label path.
	 */
	dropSpans?: boolean
	shuffleBuffer?: number
	/**
	 * Replaces the config's augmentation probabilities.
	 * A name left out is off.
	 */
	augment?: Partial<AugmentProbabilities>
	/**
	 * Replaces the config's affix relabel lexicon.
	 * `null` turns the relabel off.
	 */
	affixRelabelLexiconPath?: string | null
	/**
	 * Replaces the config's corpus directory.
	 */
	corpusDir?: string
}

/**
 * The sampler's JSON configuration for a training config.
 */
export function samplerConfigJSON(config: TrainingConfig, options: SamplerConfigOptions = {}): string {
	const { data, train } = config

	const augment = options.augment
		? Object.fromEntries(AUGMENTATIONS.map((name) => [name, options.augment?.[name] ?? 0]))
		: configAugment(data)

	const relabel =
		options.affixRelabelLexiconPath === undefined ? data.affix_relabel_lexicon_path : options.affixRelabelLexiconPath

	return stringifyJSON({
		corpus_dir: options.corpusDir ?? data.corpus_dir,
		country_weights: data.country_weights,
		source_weights: data.source_weights,
		source_reps: data.source_reps && Object.keys(data.source_reps).length ? data.source_reps : null,
		run_length: {
			max_steps: train.max_steps,
			batch_size: train.batch_size,
			grad_accum_steps: train.grad_accum_steps,
		},
		coarse_filter: data.coarse_filter,
		active_tags: [...STAGE3_TAGS],
		augment,
		augment_exclude_sources: data.augment_exclude_sources,
		affix_relabel_lexicon_path: relabel || null,
		postcode_layouts_path: POSTCODE_LAYOUTS_PATH,
		drop_spans: options.dropSpans ?? false,
		data_root: $public.MAILWOMAN_DATA_ROOT,
		volume_mount: $public.MAILWOMAN_VOLUME_MOUNT,
		sha256_cache_path: $public.MAILWOMAN_SHA256_CACHE ?? null,
		...(options.shuffleBuffer == null ? {} : { shuffle_buffer: options.shuffleBuffer }),
	})
}

/**
 * Options for the row and batch streams.
 */
export interface StreamReadOptions {
	/**
	 * Rows read from the addon per call.
	 * A consumer holds at most one chunk.
	 *
	 * @default 1024
	 */
	chunk?: number
	/**
	 * Receives the events the stream was opened to collect, after each chunk.
	 */
	onEvents?: (events: SamplerEvent[]) => void
	/**
	 * Stops the stream at its next read.
	 */
	signal?: AbortSignal
}

const DEFAULT_CHUNK = 1024

function watch(stream: { cancel(): void }, signal: AbortSignal | undefined): void {
	signal?.addEventListener("abort", () => stream.cancel(), { once: true })
}

/**
 * The sampler's rows in order, read a chunk at a time.
 */
export function* sampledRows(sampler: NativeSampler, options: StreamReadOptions = {}): Generator<SampledRow> {
	watch(sampler, options.signal)

	for (;;) {
		const rows = sampler.nextRows(options.chunk ?? DEFAULT_CHUNK)

		options.onEvents?.(sampler.takeEvents())

		if (!rows.length) return

		yield* rows
	}
}

/**
 * The sampler's rows in batches of `batchSize`, the last one partial.
 */
export function* sampledBatches(
	sampler: NativeSampler,
	batchSize: number,
	options: Omit<StreamReadOptions, "chunk"> = {}
): Generator<SampledRow[]> {
	watch(sampler, options.signal)

	for (;;) {
		const rows = sampler.nextRows(batchSize)

		options.onEvents?.(sampler.takeEvents())

		if (!rows.length) return

		yield rows
	}
}

/**
 * The upstream rows of a raw stream, as `_raw_row_stream` yielded them.
 */
export function* rawRows(stream: NativeRawRows, options: StreamReadOptions = {}): Generator<SampledRow> {
	watch(stream, options.signal)

	for (;;) {
		const rows = stream.nextRaw(options.chunk ?? DEFAULT_CHUNK)

		options.onEvents?.(stream.takeEvents())

		if (!rows.length) return

		yield* rows
	}
}

/**
 * Each upstream row of a raw stream with the rows the emit step made of it, as `emit_row` made them.
 */
export function* emittedDraws(
	stream: NativeRawRows,
	options: StreamReadOptions = {}
): Generator<{ drawn: SampledRow; emitted: SampledRow[] }> {
	watch(stream, options.signal)

	for (;;) {
		const draws = stream.nextEmitted(options.chunk ?? DEFAULT_CHUNK)

		options.onEvents?.(stream.takeEvents())

		if (!draws.length) return

		yield* draws
	}
}

/**
 * Opens a split's sampler for a training config.
 */
export function openSampler(
	mtf: MTFNode,
	config: TrainingConfig,
	split: string,
	seed: number,
	options: SamplerConfigOptions & NativeStreamOptions = {}
): NativeSampler {
	const { rowLimit, events, ...document } = options

	return new mtf.Sampler(samplerConfigJSON(config, document), split, seed, { rowLimit, events })
}

/**
 * Opens a split's raw stream for a training config.
 */
export function openRawRows(
	mtf: MTFNode,
	config: TrainingConfig,
	split: string,
	seed: number,
	options: SamplerConfigOptions & NativeStreamOptions = {}
): NativeRawRows {
	const { rowLimit, events, ...document } = options

	return new mtf.RawRows(samplerConfigJSON(config, document), split, seed, { rowLimit, events })
}

/**
 * The row encoder a config's SentencePiece path encodes with.
 *
 * @throws When the config encodes on the char path or asks for a label set other than `stage3`.
 */
export function createConfigRowEncoder(mtf: MTFNode, data: TrainingConfig["data"]): NativeRowEncoder {
	if (data.char_mode !== "off") {
		throw new Error(`data.char_mode=${data.char_mode} encodes on the char path, which builds no row encoder`)
	}

	if (data.label_set !== "stage3") {
		throw new Error(`data.label_set=${stringifyJSON(data.label_set)} is only supported with data.char_mode != 'off'`)
	}

	return mtf.createRowEncoder({
		tokenizerModelPath: `${data.tokenizer_dir}/tokenizer.model`,
		labelSchemaPath: LABEL_SCHEMA_PATH,
		maxLength: data.max_length,
		postcodeShapesPath: POSTCODE_SHAPES_PATH,
		postcodeSyntaxPath: POSTCODE_SYNTAX_PATH,
		anchorLookupPath: data.anchor_lookup_path,
		anchorPaintMode: data.anchor_paint_mode as "gold" | "shaped",
		gazetteerLexiconPath: data.gazetteer_lexicon_path,
		gazetteerChoreography: data.gazetteer_choreography,
		countryLexiconPath: data.country_lexicon_path,
		streetTypeLexiconPath: data.street_type_lexicon_path,
		localitySurfaceLexiconPath: data.locality_surface_lexicon_path,
		codeUnits: data.code_unit_features,
	})
}

/**
 * The locale head's class id of a country, or the ignore index for a country it has no class for.
 */
export function localeID(country: string | null | undefined): number {
	if (!country) return IGNORE_INDEX

	const index = (LOCALE_COUNTRIES as readonly string[]).indexOf(country.trim().toUpperCase())

	return index === -1 ? IGNORE_INDEX : index
}

/**
 * The address-system head's id for a row, read from the committed registry.
 */
export type AddressSystemLookup = (country: string | null | undefined, text: string) => number

/**
 * Reads the address-system registry and returns its lookup: the `latin` system
 * for Latin-script text when the country has one, its `local` system otherwise,
 * and the ignore index for a country without a layout.
 */
export async function readAddressSystemLookup(): Promise<AddressSystemLookup> {
	const registry = await readAddressSystemRegistry()

	if (!registry) throw new Error("the address-system registry is missing; run `mailwoman dev generate address-systems`")

	const members = new Map(registry.members.map((m) => [`${m.country}/${m.script}`, m.system]))

	return (country, text) => {
		if (!country) return IGNORE_INDEX

		const code = country.trim().toUpperCase()

		if (isLatinScriptText(text)) {
			const latin = members.get(`${code}/latin`)

			if (latin != null) return latin
		}

		return members.get(`${code}/local`) ?? IGNORE_INDEX
	}
}

/**
 * One batch as the model reads it: the row encoder's arrays with each row's locale and address-system ids.
 */
export interface ModelBatch extends EncodedRows {
	localeIDs: BigInt64Array
	addressSystemIDs: BigInt64Array
}

/**
 * Encodes a batch and adds each row's locale and address-system ids in row order.
 */
export function encodeModelBatch(
	encoder: NativeRowEncoder,
	addressSystem: AddressSystemLookup,
	rows: SampledRow[]
): ModelBatch {
	return {
		...encoder.encodeBatch(rows),
		localeIDs: BigInt64Array.from(rows, (row) => BigInt(localeID(row.country))),
		addressSystemIDs: BigInt64Array.from(rows, (row) => BigInt(addressSystem(row.country, row.raw))),
	}
}

/**
 * The SHA-256 of a sampled row's text and labels, as `row_identity` in the encoder-parity
 * audit computes it: the `json.dumps(…, ensure_ascii=False, sort_keys=True)` of its fields.
 */
export function rowIdentity(row: SampledRow): string {
	const material = {
		raw: row.raw,
		tokens: row.tokens ?? [],
		labels: row.labels ?? [],
		span_starts: row.spanStarts ?? null,
		span_ends: row.spanEnds ?? null,
		span_tags: row.spanTags ?? null,
		country: row.country ?? null,
		source: row.source ?? null,
	}

	return sha256Hex(pythonJSONDumps(material, { sortKeys: true, ensureASCII: false }))
}
