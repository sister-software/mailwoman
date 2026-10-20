/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The record written once beside each parquet file the corpus build and the overlay tools produce.
 *
 *   A record states what one file holds and what produced it: the source its rows belong to, the derivation hash
 *   over the inputs that decide its bytes, the file's sha256, its row count, the license labels its rows carry
 *   with the rows under each, and the register inputs `corpus-source-inputs.json` maps its source to.
 *
 *   A frozen training manifest folds these records rather than re-reading every row, so a record is written
 *   from the same tally a re-read would compute: one `(source, license)` count per row, with an empty license
 *   recorded under {@linkcode NO_LICENSE_RECORDED}.
 *
 *   The derivation hash covers four inputs, and omitting one marks a stale file as current:
 *
 *   - The extract hash, over the data the rows were read from.
 *   - The code hash, over the `lib/` modules the file's producer reaches (`#build/code-hash`).
 *   - The canonical config, every option that changes the bytes, with the file's source, split and part.
 *   - The builder version, this package's `version`.
 */

import { readLocalJSONFile, tryReadLocalJSONFile } from "@mailwoman/core/fs/readers"
import { isFile, statPath } from "@mailwoman/core/fs/readers/stat"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { createHash, sha256File, sha256Hex } from "@mailwoman/core/hash"
import { canonicalJSON } from "@mailwoman/core/json"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { basename, dirname, type PathBuilderLike, resolvePath } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { escapeSQLString, openDuckDB } from "#parquet/duckdb"
import {
	type CorpusSourceInput,
	type CorpusSourceInputs,
	type CorpusSourceInputsFile,
	corpusSourceInputsPath,
	indexCorpusSourceInputs,
} from "#source-register/corpus-inputs"
import { NO_LICENSE_RECORDED } from "#source-register/training-manifest"

/**
 * The suffix of a parquet file's record path: `data.parquet` is described by `data.RECORD.json`.
 */
export const RECORD_FILE_SUFFIX = ".RECORD.json"

/**
 * The four inputs a file's derivation hash is computed over.
 */
export interface DerivationInputs {
	/**
	 * A digest of the data the rows were read from.
	 */
	extractHash: string
	/**
	 * A digest of the modules the file's producer reaches, from `moduleGraphHash` in `#build/code-hash`.
	 */
	codeHash: string
	/**
	 * Every option that changes the file's bytes, including its source, split and part.
	 *
	 * It is serialized by {@linkcode canonicalJSON}, so key order does not change the hash.
	 */
	config: unknown
	/**
	 * The `@mailwoman/corpus` version that wrote the file.
	 */
	builderVersion: string
}

/**
 * The inputs a caller supplies.
 * The writer adds the builder version.
 */
export interface FileDerivation {
	extractHash: string
	/**
	 * The digest of the modules the file's producer reaches, from `moduleGraphHash` in `#build/code-hash`.
	 */
	codeHash: string
	config: Record<string, unknown>
}

/**
 * Rows per license label, within one source.
 */
export type LicenseTally = Record<string, number>

/**
 * This record is written beside one parquet file.
 */
export interface ParquetFileRecord {
	source: string
	derivationHash: string
	/**
	 * The inputs {@linkcode derivationHash} was computed over, so a reader can recompute it.
	 */
	derivation: DerivationInputs
	sha256: string
	rows: number
	/**
	 * Every license label the rows carry, with the rows under each.
	 *
	 * A file written since #2741 carries one label, the SPDX or `LicenseRef-*`
	 * id of its source's register inputs.
	 */
	licenseValues: LicenseTally
	/**
	 * The producers' own statements of the rows' terms, with the rows under each,
	 * which the `license` column no longer carries.
	 *
	 * Absent from a record written before #2741.
	 */
	licenseStatements?: LicenseTally
	/**
	 * The register sources `corpus-source-inputs.json` maps {@linkcode source} to when the file was written.
	 */
	registerInputs: readonly CorpusSourceInput[]
	builtAt: string
}

/**
 * The sha256 of the canonical JSON of a file's four derivation inputs.
 */
export function derivationHash(inputs: DerivationInputs): string {
	return sha256Hex(
		canonicalJSON({
			extractHash: inputs.extractHash,
			codeHash: inputs.codeHash,
			config: inputs.config,
			builderVersion: inputs.builderVersion,
		})
	)
}

let builderVersionPromise: Promise<string> | null = null

/**
 * This package's `version`.
 */
export function corpusBuilderVersion(): Promise<string> {
	builderVersionPromise ??= readLocalJSONFile<{ version: string }>(
		resolvePackagePath("@mailwoman/corpus", "package.json")
	).then((manifest) => manifest.version)

	return builderVersionPromise
}

/**
 * Complete a caller's derivation with the builder version.
 */
export async function resolveDerivation(derivation: FileDerivation): Promise<DerivationInputs> {
	return {
		extractHash: derivation.extractHash,
		codeHash: derivation.codeHash,
		config: derivation.config,
		builderVersion: await corpusBuilderVersion(),
	}
}

/**
 * A digest of an extract on disk.
 *
 * A file is hashed whole.
 * A directory is described by its listing, one `relative path, size, mtime` line per file,
 * because an adapter directory such as Who's On First's repositories holds over 100 GB
 * and hashing it would add hours to a build.
 *
 * The listing changes when a file is added, removed, resized or rewritten.
 */
export async function extractFingerprint(path: PathBuilderLike): Promise<string> {
	if (await isFile(path)) return sha256File(path)

	const names = await Globerator.from("**/*", { cwd: path.toString(), absolute: false }).toArray()
	const hash = createHash("sha256")

	for (const name of names.toSorted()) {
		const stat = await statPath(resolvePath(path, name))

		if (!stat.isFile()) continue

		hash.update(`${name}\t${stat.size}\t${stat.mtimeMs}\n`)
	}

	return hash.digest("hex")
}

/**
 * The record path for a parquet file: `<dir>/<stem>.RECORD.json`.
 */
export function recordPathFor(parquetPath: PathBuilderLike): string {
	const path = parquetPath.toString()
	const name = basename(path)

	if (!name.endsWith(".parquet")) throw new Error(`recordPathFor: ${path} is not a .parquet file`)

	return resolvePath(dirname(path), name.slice(0, -".parquet".length) + RECORD_FILE_SUFFIX)
}

/**
 * The label a row's license is recorded under.
 */
export function licenseLabel(license: string | null | undefined): string {
	return typeof license === "string" && license ? license : NO_LICENSE_RECORDED
}

/**
 * Rows per license label, per source.
 */
export type SourceLicenseTally = Map<string, Map<string, number>>

/**
 * Add one count to a tally.
 */
export function addToTally(tally: SourceLicenseTally, source: string, label: string, rows: number): void {
	const labels = tally.get(source) ?? new Map<string, number>()

	labels.set(label, (labels.get(label) ?? 0) + rows)
	tally.set(source, labels)
}

let committedInputs: Promise<CorpusSourceInputs> | null = null

/**
 * The committed `corpus-source-inputs.json`, indexed by id and alias.
 *
 * The register audit runs where a build admits its sources.
 * A record copies the mapping the build admitted.
 */
export function committedCorpusSourceInputs(): Promise<CorpusSourceInputs> {
	committedInputs ??= readLocalJSONFile<CorpusSourceInputsFile>(corpusSourceInputsPath()).then(indexCorpusSourceInputs)

	return committedInputs
}

export interface WriteParquetRecordOptions {
	/**
	 * The parquet file the record describes.
	 * It must already be written.
	 */
	path: PathBuilderLike
	/**
	 * Rows per license label, per source, counted while the file was written.
	 *
	 * A record names one source, so a tally with more than one is refused.
	 */
	tally: SourceLicenseTally
	derivation: DerivationInputs
	builtAt: string
	/**
	 * The producers' statements the writer replaced with the license id, with the rows under each.
	 */
	statements?: ReadonlyMap<string, number>
	/**
	 * @defaultValue {@linkcode committedCorpusSourceInputs}
	 */
	sourceInputs?: CorpusSourceInputs
}

/**
 * A tally's entries sorted by key, as a record stores them.
 */
function sortedTally(tally: ReadonlyMap<string, number>): LicenseTally {
	return Object.fromEntries([...tally].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/**
 * Write the record beside one parquet file and return it.
 *
 * @throws When the tally holds no source or more than one, or when
 * `corpus-source-inputs.json` maps no entry to the source, since a record without
 * register inputs would hide the gap the table exists to show.
 */
export async function writeParquetRecord(options: WriteParquetRecordOptions): Promise<ParquetFileRecord> {
	const path = options.path.toString()
	const sources = [...options.tally.keys()]

	if (sources.length !== 1) {
		throw new Error(
			`${path} holds ${sources.length} sources (${sources.join(", ")}); a record describes a file of one source.`
		)
	}

	const source = sources[0]!
	const inputs = options.sourceInputs ?? (await committedCorpusSourceInputs())
	const mapping = inputs.resolve(source)

	if (!mapping) {
		throw new Error(
			`${path} holds rows of ${source}, which corpus-source-inputs.json maps to no register source. ` +
				`Add the source to the table before writing its rows.`
		)
	}

	const labels = options.tally.get(source)!

	const record: ParquetFileRecord = {
		source,
		derivationHash: derivationHash(options.derivation),
		derivation: options.derivation,
		sha256: await sha256File(path),
		rows: [...labels.values()].reduce((total, rows) => total + rows, 0),
		licenseValues: sortedTally(labels),
		...(options.statements?.size ? { licenseStatements: sortedTally(options.statements) } : {}),
		registerInputs: mapping.mapping.inputs,
		builtAt: options.builtAt,
	}

	await writeLocalJSONFile(record, recordPathFor(path))

	return record
}

/**
 * The record beside a parquet file, or `null` when none was written.
 */
export function readParquetRecord(parquetPath: PathBuilderLike): Promise<ParquetFileRecord | null> {
	return tryReadLocalJSONFile<ParquetFileRecord>(recordPathFor(parquetPath))
}

/**
 * Count rows per `(source, license)` by reading the files' rows.
 *
 * @throws When a row carries no source, because no record could attribute it.
 */
export async function readSourceLicenseTally(paths: readonly string[]): Promise<SourceLicenseTally> {
	const tally: SourceLicenseTally = new Map()

	if (!paths.length) return tally

	using db = await openDuckDB({ threads: 8 })

	const list = paths.map((path) => `'${escapeSQLString(path)}'`).join(", ")

	const result = await db.runAndReadAll(
		`SELECT source, license, count(*) AS rows FROM read_parquet([${list}]) GROUP BY source, license`
	)

	for (const row of result.getRows()) {
		const [source, license, rows] = row as [unknown, unknown, unknown]
		const count = Number(rows)

		if (typeof source !== "string" || !source) {
			throw new Error(`${count.toLocaleString()} rows carry no source, so no record can attribute them`)
		}

		addToTally(tally, source, licenseLabel(license as string | null), count)
	}

	return tally
}

/**
 * One file a corpus manifest lists.
 */
export interface ListedParquetFile {
	path: string
	rows: number
	sha256?: string
}

export interface FoldedSourceLicenses {
	tally: SourceLicenseTally
	/**
	 * Files whose counts came from their record.
	 */
	folded: number
	/**
	 * Files whose rows were read because they have no record.
	 */
	reread: number
}

/**
 * Tally rows per `(source, license)` over a manifest's files, from each file's record
 * where one exists and by reading rows for the files that have none.
 *
 * @throws When a record disagrees with the manifest on the file's rows or sha256,
 * or the re-read files hold a different number of rows than the manifest lists for them.
 */
export async function foldSourceLicenses(files: readonly ListedParquetFile[]): Promise<FoldedSourceLicenses> {
	const tally: SourceLicenseTally = new Map()
	const unrecorded: ListedParquetFile[] = []
	let folded = 0

	for (const file of files) {
		const record = await readParquetRecord(file.path)

		if (!record) {
			unrecorded.push(file)

			continue
		}

		if (record.rows !== file.rows) {
			throw new Error(`${recordPathFor(file.path)} records ${record.rows} rows and the manifest lists ${file.rows}`)
		}

		if (file.sha256 && record.sha256 !== file.sha256) {
			throw new Error(
				`${recordPathFor(file.path)} records sha256 ${record.sha256} and the manifest lists ${file.sha256}`
			)
		}

		for (const [label, rows] of Object.entries(record.licenseValues)) {
			addToTally(tally, record.source, label, rows)
		}

		folded++
	}

	const reread = await readSourceLicenseTally(unrecorded.map((file) => file.path))
	const listed = unrecorded.reduce((total, file) => total + file.rows, 0)
	let counted = 0

	for (const [source, labels] of reread) {
		for (const [label, rows] of labels) {
			addToTally(tally, source, label, rows)

			counted += rows
		}
	}

	if (counted !== listed) {
		throw new Error(
			`the ${unrecorded.length} files without a record hold ${counted.toLocaleString()} rows ` +
				`and the manifest lists ${listed.toLocaleString()}`
		)
	}

	return { tally, folded, reread: unrecorded.length }
}

/**
 * Shape a tally into the per-source entries a frozen training manifest records.
 *
 * A source whose rows carry several labels records the majority label as its license and keeps
 * every label with its rows, so the record states the whole set rather than one row's reading.
 */
export function rowsBySourceFromTally(
	tally: SourceLicenseTally
): Map<string, { rows: number; license: string; licenseValues?: Record<string, number> }> {
	return new Map(
		[...tally].map(([source, labels]) => {
			const ordered = [...labels].toSorted(([a, left], [b, right]) => right - left || a.localeCompare(b))
			const rows = ordered.reduce((total, [, count]) => total + count, 0)

			return [
				source,
				{
					rows,
					license: ordered[0]![0],
					...(ordered.length > 1 ? { licenseValues: Object.fromEntries(ordered) } : {}),
				},
			]
		})
	)
}
