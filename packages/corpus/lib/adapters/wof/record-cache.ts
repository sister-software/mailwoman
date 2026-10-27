/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reuses the parsed WOF records of an earlier walk when no input file and no parser line has changed.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { openWriteStream } from "@mailwoman/core/fs/streams"
import { makeDirectories, movePath, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { sha256File, sha256Hex } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { fileURLToPath } from "@mailwoman/core/module/file-url"
import { once } from "@mailwoman/core/utils/events"
import { dirname, type PathBuilderLike, resolvePathBuilder } from "path-ts"
import { JSONSpliterator } from "spliterator"

import { $public } from "#env"
import { extractFingerprint } from "#parquet/record"
import { walkFeatures, type WOFRecord } from "#utils/wof-json"

/**
 * A {@link WOFRecord} as one cache line: `nameVariants` as entries, since a `Map` has no JSON form.
 */
interface CachedRecord extends Omit<WOFRecord, "nameVariants"> {
	nameVariants: Array<[string, string | readonly string[]]>
}

/**
 * The module whose parsing the cache stands in for.
 * A change to it changes the cache key.
 */
const PARSER_MODULE = import.meta.resolve("#utils/wof-json")

/**
 * The cache file for `repoDir`: its {@linkcode extractFingerprint}, which lists every
 * file's path, size and modification time, and the sha256 of the parser module.
 *
 * A commit, an uncommitted edit or a parser change gives a new key.
 */
export async function wofRecordCachePath(repoDir: PathBuilderLike, cacheDir: PathBuilderLike): Promise<string> {
	const parser = await sha256File(fileURLToPath(PARSER_MODULE))
	const key = sha256Hex(`${await extractFingerprint(repoDir)}\n${parser}`)

	return resolvePathBuilder(cacheDir, `${key}.jsonl`).toString()
}

/**
 * The cache directory `MAILWOMAN_WOF_RECORD_CACHE` sets, resolved against the
 * data root when relative, or `null`.
 */
function configuredCacheDir(): string | null {
	const configured = $public.MAILWOMAN_WOF_RECORD_CACHE

	if (!configured) return null

	return configured.startsWith("/") ? configured : dataRootPath(configured).toString()
}

/**
 * Every record {@linkcode walkFeatures} yields for `repoDir`, in the same order,
 * read from the cache when its key matches.
 *
 * `cacheDir` defaults to `MAILWOMAN_WOF_RECORD_CACHE`; with neither, this is {@linkcode walkFeatures}.
 * A walk that finishes writes the cache.
 * An aborted or abandoned walk leaves none.
 */
export async function* walkFeaturesCached(
	repoDir: PathBuilderLike,
	opts: { signal?: AbortSignal; cacheDir?: PathBuilderLike } = {}
): AsyncIterable<WOFRecord> {
	const cacheDir = opts.cacheDir ?? configuredCacheDir()

	if (!cacheDir) {
		yield* walkFeatures(repoDir, { signal: opts.signal })

		return
	}

	const file = await wofRecordCachePath(repoDir, cacheDir)

	if (await pathExists(file)) {
		for await (const line of JSONSpliterator.fromAsync<CachedRecord>(file)) {
			if (opts.signal?.aborted) return

			yield { ...line, nameVariants: new Map(line.nameVariants) }
		}

		return
	}

	await makeDirectories(dirname(file))

	const partial = `${file}.partial`
	const stream = openWriteStream(partial, { encoding: "utf8" })
	let complete = false

	try {
		for await (const record of walkFeatures(repoDir, { signal: opts.signal })) {
			const line: CachedRecord = { ...record, nameVariants: [...record.nameVariants] }

			if (!stream.write(`${stringifyJSON(line)}\n`)) {
				await once(stream, "drain")
			}

			yield record
		}

		complete = !opts.signal?.aborted
	} finally {
		stream.end()
		await once(stream, "close")

		await (complete ? movePath(partial, file) : removePathIfPresent(partial))
	}
}
