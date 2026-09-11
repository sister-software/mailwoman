/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reads and writes corpus-source manifests.
 */

import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { openWriteStream, pipeline, Readable } from "@mailwoman/core/fs/streams"
import { movePath, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { tryParsingJSON } from "@mailwoman/core/json"

import { HTTPStatusError, type SourceManifest } from "#tools/fetch/download/network"

/**
 * Read a MANIFEST.json; `null` when missing or corrupt (callers re-fetch from scratch).
 */
export async function readManifest<T>(path: string): Promise<T | null> {
	if (!(await pathExists(path))) return null

	// A read failure (e.g. the file vanished after the existsSync probe) maps to null like corrupt
	// JSON does; tryParsingJSON returns null for the non-string sentinel.
	const text = await readLocalTextFile(path).catch(() => null)

	return tryParsingJSON<T>(text)
}

/**
 * Load manifest entries into a map so untouched keys survive a partial re-fetch.
 */
export async function loadManifestEntries<T>(path: string, key: (entry: T) => string): Promise<Map<string, T>> {
	const entries = new Map<string, T>()
	const parsed = await readManifest<T[]>(path)

	for (const entry of parsed ?? []) {
		entries.set(key(entry), entry)
	}

	return entries
}

/**
 * Write a MANIFEST.json in the house shape: pretty-printed, trailing newline.
 */
export async function writeManifest(path: string, manifest: unknown): Promise<void> {
	await writeLocalTextFile(JSON.stringify(manifest, null, 2) + "\n", path)
}

/**
 * The sibling `MANIFEST.json` shape for a source that is a COLLECTION of files behind one portal (a monthly register
 * published per region, per industry, or per first letter). It carries what a trained artifact has to be able to cite
 * later: the license the portal labels the data with, the attribution wording it requires, and one
 * {@link SourceManifest} per file.
 */
export interface SourceCollectionManifest {
	source: string
	source_url: string
	license: string
	attribution: string
	downloaded_at: string
	files: SourceManifest[]
}

/**
 * Pipe a response body to `dest` and answer the byte count. The one primitive the portal fetchers share when the
 * request is not a bare GET — a session cookie, a CSRF header, or a form POST stands between the listing and the file,
 * so {@link streamDownload}'s URL-only contract does not fit and each module builds its own `Response` first. Writes a
 * `.tmp` sibling and renames, so an interrupted transfer never lands at the final path looking complete.
 */
export async function streamBodyToFile(res: Response, dest: string): Promise<number> {
	if (!res.body) throw new HTTPStatusError(res.status, `HTTP ${res.status} with no body — ${res.url}`)
	let bytes = 0

	const counter = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			bytes += chunk.byteLength
			controller.enqueue(chunk)
		},
	})

	const tmp = dest + ".tmp"
	await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), openWriteStream(tmp))
	await movePath(tmp, dest)

	return bytes
}

/**
 * The per-file entries of a {@link SourceCollectionManifest} keyed by file name, or an empty map when the manifest is
 * missing or not in the collection shape, so a re-run after an interruption fetches only what is missing. The
 * single-file modules' `loadManifestEntries` reads a bare array and is not this.
 */
export async function loadCollectionFiles(path: string): Promise<Map<string, SourceManifest>> {
	const parsed = await readManifest<SourceCollectionManifest>(path)
	const entries = new Map<string, SourceManifest>()

	for (const entry of Array.isArray(parsed?.files) ? parsed.files : []) {
		entries.set(entry.filename, entry)
	}

	return entries
}
