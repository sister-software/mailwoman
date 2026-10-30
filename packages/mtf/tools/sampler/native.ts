/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mtf-node` addon: the training-row sampler and the row encoders of `crates/mtf-node`, loaded into Node.
 *
 *   Cargo builds the addon from source the first time a process asks for it, under the root workspace's `node`
 *   profile and the toolchain the root `rust-toolchain.toml` pins, into the root `target/node/`. The build
 *   reads `mtf-sampler` with its parquet reader, so it stays out of the browser `wasm/mtf.wasm`, whose one dependency is
 *   `mtf-core`. The addon is built for the host it runs on: Linux and macOS, where Cargo writes the library to
 *   `libmtf_node.so` and `libmtf_node.dylib`.
 */

import { repoRootPath, workspacePath } from "@mailwoman/core/paths"
import { runFile } from "@mailwoman/core/process"
import { platformName as platform } from "@mailwoman/core/utils/system"

/**
 * One sampled row.
 * The span triple is present when the row's file stores one.
 */
export interface SampledRow {
	raw: string
	tokens: string[]
	labels: string[]
	country: string | null
	source: string
	spanStarts?: number[] | null
	spanEnds?: number[] | null
	spanTags?: string[] | null
}

/**
 * A count per source.
 */
export interface SourceCount {
	source: string
	count: number
}

/**
 * A count per postcode-move outcome.
 */
export interface OutcomeCount {
	outcome: string
	count: number
}

/**
 * The kinds of event the sampler reports.
 */
export const SamplerEventKind = {
	RowEmitted: "row_emitted",
	RowSkipped: "row_skipped",
	SourceRestarted: "source_restarted",
	EpochComplete: "epoch_complete",
} as const

export type SamplerEventKind = (typeof SamplerEventKind)[keyof typeof SamplerEventKind]

/**
 * One sampler event, with the fields its kind sets.
 */
export interface SamplerEvent {
	kind: SamplerEventKind
	index?: number | null
	source?: string | null
	country?: string | null
	reason?: string | null
	raw?: string | null
	passes?: number | null
	realized?: SourceCount[] | null
}

/**
 * What opening a stream takes beyond the config, split and seed.
 */
export interface NativeStreamOptions {
	/**
	 * Caps the rows the stream emits, counted before the astral skip.
	 */
	rowLimit?: number | null
	/**
	 * The event kinds to collect for `takeEvents`.
	 */
	events?: SamplerEventKind[] | null
}

export interface NativeSampler {
	nextRows(count: number): SampledRow[]
	takeEvents(): SamplerEvent[]
	cancel(): void
	readonly yielded: number
	readonly astralSkipped: number
	readonly postcodeMoveOutcomes: OutcomeCount[]
}

export interface NativeTrainingBatches {
	nextBatch(): SampledRow[]
	cancel(): void
	readonly epoch: number
}

/**
 * One upstream row and the rows the emit step made of it.
 */
export interface EmittedDraw {
	drawn: SampledRow
	emitted: SampledRow[]
}

export interface NativeRawRows {
	nextRaw(count: number): SampledRow[]
	nextEmitted(count: number): EmittedDraw[]
	takeEvents(): SamplerEvent[]
	cancel(): void
	readonly drawn: number
	readonly postcodeMoveOutcomes: OutcomeCount[]
}

/**
 * One row group's admitted rows over the requested columns.
 */
export interface SplitColumnChunk {
	rows: number
	strings: Record<string, Array<string | null>>
	lists: Record<string, Array<string[] | null>>
	/**
	 * Each list-of-integers column, such as `span_starts`.
	 */
	intLists: Record<string, Array<number[] | null>>
}

/**
 * The rows a split read keeps: those whose string column `column`, uppercased, is one of `values`.
 * A row whose value is null is not kept.
 */
export interface SplitKeep {
	column: string
	values: string[]
}

/**
 * Every row a split holds over a few columns, in file and row order.
 */
export interface NativeSplitColumns {
	readonly files: number
	nextChunk(): SplitColumnChunk | null
}

/**
 * What a row encoder reads.
 * Every lexicon path left unset leaves its channel off.
 */
export interface RowEncoderOptions {
	tokenizerModelPath: string
	labelSchemaPath: string
	labelSet?: string | null
	maxLength: number
	padID?: number | null
	postcodeShapesPath: string
	postcodeSyntaxPath: string
	anchorLookupPath?: string | null
	anchorPaintMode?: "gold" | "shaped" | null
	gazetteerLexiconPath?: string | null
	gazetteerChoreography?: boolean | null
	countryLexiconPath?: string | null
	streetTypeLexiconPath?: string | null
	localitySurfaceLexiconPath?: string | null
	codeUnits?: boolean | null
}

/**
 * One configured channel of an encoded batch: `features` `[B, L, dim]` and `confidence` `[B, L]`.
 */
export interface EncodedChannel {
	name: string
	dim: number
	features: Float32Array
	confidence: Float32Array
}

/**
 * An encoded batch: `inputIDs`, `attentionMask` and `labels` int64 `[B, L]` in row-major order.
 */
export interface EncodedRows {
	rows: number
	maxLength: number
	inputIDs: BigInt64Array
	attentionMask: BigInt64Array
	labels: BigInt64Array
	channels: EncodedChannel[]
}

export interface NativeRowEncoder {
	encodeBatch(rows: SampledRow[]): EncodedRows
	readonly channelDims: Array<{ name: string; dim: number }>
}

/**
 * The character path's settings.
 */
export interface CharEncoderOptions {
	mode: "word" | "char"
	vocabPath: string
	maxUnits: number
	maxUnitWidth: number
	charCtx?: number | null
	labelSet: string
	labelSchemaPath: string
}

/**
 * A char-path batch: `charIDs` int64 `[B, S, W]`, `attentionMask` and `labels` int64 `[B, S]`.
 */
export interface EncodedChars {
	rows: number
	maxUnits: number
	maxUnitWidth: number
	charIDs: BigInt64Array
	attentionMask: BigInt64Array
	labels: BigInt64Array
}

export interface NativeCharEncoder {
	encodeBatch(rows: SampledRow[]): EncodedChars
}

export interface SourceWeight {
	source: string
	weight: number
}

export interface DerivedSourceReps {
	source: string
	targetRepsPerRow: number
	rows: number
	weight: number
}

/**
 * The addon's exports, as `crates/mtf-node/src/lib.rs` declares them.
 */
interface NativeModule {
	Sampler: new (config: string, split: string, seed: number, options?: NativeStreamOptions | null) => NativeSampler
	TrainingBatches: new (
		config: string,
		batchSize: number,
		seed: number,
		rowLimit?: number | null,
		skipBatches?: number | null
	) => NativeTrainingBatches
	RawRows: new (config: string, split: string, seed: number, options?: NativeStreamOptions | null) => NativeRawRows
	SplitColumns: new (config: string, split: string, columns: string[], keep?: SplitKeep | null) => NativeSplitColumns
	RowEncoder: new (options: NativeRowEncoderOptions) => {
		encodeBatch(rows: SampledRow[]): RawEncodedRows
		readonly channelDims: Array<{ name: string; dim: number }>
	}
	CharEncoder: new (options: CharEncoderOptions) => { encodeBatch(rows: SampledRow[]): RawEncodedChars }
	sourceRowCounts(config: string, split: string): SourceCount[]
	deriveSourceWeights(
		fixed: SourceWeight[] | null,
		sourceReps: SourceWeight[],
		rowsBySource: SourceCount[],
		samples: number
	): { merged: SourceWeight[]; derived: DerivedSourceReps[] }
	channelNames(): string[]
	pythonCasefold(text: string): string
	pythonScriptRuns(text: string): string[]
	pythonDetectScript(text: string): string
	pythonIsLatinText(text: string): boolean
}

/**
 * Python 3.12's string semantics for the training tools, read from the CPython
 * Unicode tables in `mtf-channels/src/python_text/tables.rs`.
 *
 * Node's ICU follows another Unicode version and has no character-name table.
 */
export interface PythonText {
	/**
	 * `str.casefold`.
	 */
	casefold(text: string): string
	/**
	 * The consecutive runs of letter scripts, every character that is not a letter skipped,
	 * as the mixed-script audit's `script_runs` names them.
	 */
	scriptRuns(text: string): string[]
	/**
	 * The exposure phenomena's coarse script tag: a script block, `mixed` or `other`.
	 */
	detectScript(text: string): string
	/**
	 * Whether the text holds a letter and every letter is Latin script by Unicode name.
	 */
	isLatinText(text: string): boolean
}

/**
 * napi-rs camel-cases each Rust field name, so `pad_id` arrives as `padId`.
 */
type NativeRowEncoderOptions = Omit<RowEncoderOptions, "padID"> & { padId?: number | null }

interface RawEncodedRows extends Omit<EncodedRows, "inputIDs"> {
	inputIds: BigInt64Array
}

interface RawEncodedChars extends Omit<EncodedChars, "charIDs"> {
	charIds: BigInt64Array
}

/**
 * The file Cargo writes the addon to on each platform the addon builds for.
 */
const LIBRARY_NAMES: Partial<Record<string, string>> = {
	linux: "libmtf_node.so",
	darwin: "libmtf_node.dylib",
}

/**
 * Cargo's output for one build can run long, so the buffer is far above Node's 1 MB default.
 */
const OUTPUT_LIMIT = 1 << 30

let addon: Promise<NativeModule> | null = null

/**
 * The path of a current `mtf-node` build, building it first.
 *
 * Cargo rebuilds only when a crate source, a manifest or the lockfile changed,
 * so a current build costs a second.
 */
export async function buildMTFNode(): Promise<string> {
	const name = LIBRARY_NAMES[platform()]

	if (!name) {
		throw new Error(`mtf-node builds on Linux and macOS; this host is ${platform()}`)
	}

	await runFile("cargo", ["build", "--profile", "node", "--locked", "-p", "mtf-node"], {
		cwd: workspacePath("mtf"),
		maxBuffer: OUTPUT_LIMIT,
	})

	return repoRootPath("target", "node", name)
}

/**
 * The loaded addon, built the first time a process asks.
 */
export function loadMTFNode(): Promise<NativeModule> {
	addon ??= (async () => {
		const path = await buildMTFNode()
		const module = { exports: {} as NativeModule }

		// `require` loads an addon only from a `.node` file, and Cargo gives the library the
		// platform's extension, so the addon is opened the way `require` opens one.
		process.dlopen(module, path)

		return module.exports
	})()

	return addon
}

/**
 * The addon's classes and functions under the repository's identifier spelling.
 */
export interface MTFNode {
	Sampler: NativeModule["Sampler"]
	TrainingBatches: NativeModule["TrainingBatches"]
	RawRows: NativeModule["RawRows"]
	SplitColumns: NativeModule["SplitColumns"]
	createRowEncoder(options: RowEncoderOptions): NativeRowEncoder
	createCharEncoder(options: CharEncoderOptions): NativeCharEncoder
	sourceRowCounts: NativeModule["sourceRowCounts"]
	deriveSourceWeights: NativeModule["deriveSourceWeights"]
	channelNames: NativeModule["channelNames"]
	pythonText: PythonText
}

/**
 * The addon, with the encoders' outputs renamed to the repository's acronym spelling.
 */
export async function mtfNode(): Promise<MTFNode> {
	const native = await loadMTFNode()

	return {
		Sampler: native.Sampler,
		TrainingBatches: native.TrainingBatches,
		RawRows: native.RawRows,
		SplitColumns: native.SplitColumns,
		createRowEncoder(options) {
			const { padID, ...rest } = options
			// napi-rs reads an `Option` from `undefined` and refuses `null`, which an unset config path holds.
			const present = Object.fromEntries(Object.entries(rest).filter(([, value]) => value != null))
			const encoder = new native.RowEncoder({ ...(present as typeof rest), padId: padID })

			return {
				get channelDims() {
					return encoder.channelDims
				},
				encodeBatch(rows) {
					const { inputIds, ...batch } = encoder.encodeBatch(rows)

					return { ...batch, inputIDs: inputIds }
				},
			}
		},
		createCharEncoder(options) {
			const encoder = new native.CharEncoder(options)

			return {
				encodeBatch(rows) {
					const { charIds, ...batch } = encoder.encodeBatch(rows)

					return { ...batch, charIDs: charIds }
				},
			}
		},
		sourceRowCounts: native.sourceRowCounts,
		deriveSourceWeights: native.deriveSourceWeights,
		channelNames: native.channelNames,
		pythonText: {
			casefold: native.pythonCasefold,
			scriptRuns: native.pythonScriptRuns,
			detectScript: native.pythonDetectScript,
			isLatinText: native.pythonIsLatinText,
		},
	}
}
