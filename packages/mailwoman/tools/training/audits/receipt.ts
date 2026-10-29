/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   What every training audit writes: its report, byte for byte as the Python audit's `json.dumps` wrote it, and the
 *   preflight receipt the GPU run checks before it trains.
 *
 *   A report is a Python `json.dumps(report, indent=2)`, so a reader of an earlier report and of a new one reads the
 *   same bytes. A plain `number` in a report is an `int` and {@linkcode PythonFloat} marks a `float`.
 *
 *   The preflight receipt is written only after every audit a config declares has passed, so its presence is the
 *   pass. Its key binds it to the config's bytes and the set of file sha256s the corpus manifest lists, so the GPU
 *   run checks it in milliseconds without hashing a parquet file.
 */

import { readLocalBuffer, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { isFile } from "@mailwoman/core/fs/readers/stat"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { pythonJSONDumps } from "@mailwoman/core/strings/python-json"

/**
 * How a report is serialized, as the Python audit that wrote it serialized it.
 */
export interface AuditReportOptions {
	/**
	 * `ensure_ascii`.
	 *
	 * The census audits kept Python's default, and `epoch_mixture`, `suffix_feed`
	 * and `mixed_script` turned it off.
	 *
	 * @default true
	 */
	ensureASCII?: boolean
	/**
	 * Whether the file ends with a newline after the JSON.
	 *
	 * @default false
	 */
	trailingNewline?: boolean
}

/**
 * A report's text: `json.dumps(report, indent=2)` with the audit's `ensure_ascii`.
 */
export function auditReportText(report: unknown, options: AuditReportOptions = {}): string {
	return (
		pythonJSONDumps(report, { indent: 2, ensureASCII: options.ensureASCII ?? true }) +
		(options.trailingNewline ? "\n" : "")
	)
}

/**
 * Writes a report and prints where it went.
 */
export async function writeAuditReport(path: string, report: unknown, options: AuditReportOptions = {}): Promise<void> {
	await writeLocalTextFile(auditReportText(report, options), path)

	console.log(`wrote ${path}`)
}

/**
 * A map's entries sorted by key in code-point order, as Python's `sorted(d.items())` orders string keys.
 */
export function sortedByKey<V>(entries: Iterable<[string, V]>): Array<[string, V]> {
	return [...entries].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * A floor a config declares that the measured corpus does not meet.
 *
 * The report travels with the error, so a reader has the numbers that failed.
 */
export class AuditFloorError extends Error {
	readonly report: unknown

	constructor(message: string, report: unknown) {
		super(message)
		this.name = "AuditFloorError"
		this.report = report
	}
}

/**
 * Bumped when the key's inputs change, so an older receipt never satisfies a newer check.
 */
export const PREFLIGHT_RECEIPT_VERSION = 1

/**
 * The manifest keys a corpus listed its parquet files under before `files`, as `manifest_files` reads them.
 */
const RETIRED_MANIFEST_KEYS = ["sl" + "ices", "sh" + "ards"]

interface ManifestEntry {
	path?: string
	sha256?: string | null
	split_attribute?: { sha256?: string | null } | null
}

/**
 * The manifest's parquet file list: the first of `files` and the retired keys that holds a non-empty list.
 */
function listedParquetFiles(manifest: Record<string, unknown>): ManifestEntry[] {
	for (const key of ["files", ...RETIRED_MANIFEST_KEYS]) {
		const listed = manifest[key]

		if (Array.isArray(listed) && listed.length) return listed as ManifestEntry[]
	}

	return []
}

/**
 * The sorted, de-duplicated sha256s the corpus manifest lists for its files and their split attributes.
 *
 * @throws When the manifest is absent, lists no file, or lists a file without a sha256.
 */
export async function manifestFileDigests(corpusDir: string): Promise<string[]> {
	const manifest = `${corpusDir}/MANIFEST.json`

	if (!(await isFile(manifest))) throw new Error(`the preflight receipt key needs ${manifest}`)

	const digests = new Set<string>()

	for (const entry of listedParquetFiles(await readLocalJSONFile(manifest))) {
		if (!entry.sha256) {
			throw new Error(`${manifest} lists ${entry.path} with no sha256, so no receipt can bind it`)
		}

		digests.add(String(entry.sha256))

		const attribute = entry.split_attribute

		if (attribute && typeof attribute === "object" && attribute.sha256) {
			digests.add(String(attribute.sha256))
		}
	}

	if (!digests.size) throw new Error(`${manifest} lists no files, so no receipt can bind it`)

	return [...digests].toSorted()
}

async function fileSHA256(path: string): Promise<string> {
	return sha256Hex(await readLocalBuffer(path))
}

/**
 * The receipt key: a digest of the version, the config's sha256 and the manifest's file sha256 set.
 */
export async function preflightKey(configPath: string, corpusDir: string): Promise<string> {
	const lines = [
		`preflight-v${PREFLIGHT_RECEIPT_VERSION}\n`,
		`config ${await fileSHA256(configPath)}\n`,
		...(await manifestFileDigests(corpusDir)).map((digest) => `file ${digest}\n`),
	]

	return sha256Hex(lines.join(""))
}

/**
 * Where the receipt for a key lives under the audit root.
 */
export function preflightReceiptPath(auditRoot: string, key: string): string {
	return `${auditRoot}/preflight-${key}.json`
}

/**
 * Writes the receipt for audits that all passed and returns its key, the token the GPU run presents.
 */
export async function writePreflightReceipt(
	auditRoot: string,
	configPath: string,
	corpusDir: string,
	audits: readonly string[],
	reports: Record<string, string>
): Promise<string> {
	const key = await preflightKey(configPath, corpusDir)

	const body = {
		version: PREFLIGHT_RECEIPT_VERSION,
		key,
		config: configPath,
		config_sha256: await fileSHA256(configPath),
		corpus_dir: corpusDir,
		manifest_file_count: (await manifestFileDigests(corpusDir)).length,
		audits: [...audits].toSorted(),
		reports,
	}

	await writeLocalTextFile(
		pythonJSONDumps(body, { indent: 2, sortKeys: true }) + "\n",
		preflightReceiptPath(auditRoot, key)
	)

	return key
}

/**
 * The GPU run found no receipt matching its config and corpus.
 */
export class PreflightReceiptError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "PreflightReceiptError"
	}
}

/**
 * Refuses unless `token` is this config and corpus's key and its receipt records every `required` audit.
 */
export async function verifyPreflightReceipt(
	auditRoot: string,
	configPath: string,
	corpusDir: string,
	token: string,
	required: readonly string[]
): Promise<void> {
	if (!token) throw new PreflightReceiptError("no preflight token: run the CPU preflight before allocating a GPU")

	const key = await preflightKey(configPath, corpusDir)

	if (token !== key) {
		throw new PreflightReceiptError(
			`the preflight token ${token.slice(0, 12)}… was issued for other config or manifest bytes than these (${key.slice(0, 12)}…)`
		)
	}

	const path = preflightReceiptPath(auditRoot, key)

	const body = await readLocalJSONFile<{ version?: number; key?: string; audits?: string[] }>(path).catch(() => {
		throw new PreflightReceiptError(`the preflight receipt ${path} is unreadable`)
	})

	if (body.version !== PREFLIGHT_RECEIPT_VERSION || body.key !== key) {
		throw new PreflightReceiptError(`${path} is not a version-${PREFLIGHT_RECEIPT_VERSION} receipt for key ${key}`)
	}

	const missing = [...new Set(required)].filter((audit) => !(body.audits ?? []).includes(audit)).toSorted()

	if (missing.length) {
		throw new PreflightReceiptError(`${path} records no pass for [${missing.map((m) => `'${m}'`).join(", ")}]`)
	}
}

/**
 * The digest of the config file and the corpus manifest, each prefixed by its length as an
 * 8-byte big-endian integer: the token that binds a passing corpus-receipt audit to those bytes.
 */
export async function corpusReceiptBinding(configPath: string, corpusDir: string): Promise<string> {
	const manifest = `${corpusDir}/MANIFEST.json`

	if (!(await isFile(manifest))) throw new Error(`required corpus receipt binding needs ${manifest}`)

	const parts: Buffer[] = []

	for (const path of [configPath, manifest]) {
		const contents = await readLocalBuffer(path)
		const length = Buffer.alloc(8)

		length.writeBigUInt64BE(BigInt(contents.length))
		parts.push(length, contents)
	}

	return sha256Hex(Buffer.concat(parts))
}
