/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Downloads the open profile's pinned sources into the data root and checks them against the lock.
 */

import { APIClient } from "@mailwoman/core/api"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { writeLocalFile, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { workspacePathBuilder } from "@mailwoman/core/paths"
import type { PathBuilder } from "path-ts"

import {
	OPEN_PROFILE,
	type SourceDefinition,
	type SourceID,
	type SourceLock,
	type SourceLockEntry,
	sourcePath,
	SOURCES,
} from "#sdk/sources"

/**
 * The lock the build reads.
 */
export function sourceLockPath(): PathBuilder {
	return workspacePathBuilder("registry", "data", "manifests", "sources.lock.json")
}

/**
 * The UN Statistics Division's M49 crosswalk, considered and refused, with the terms that refused it.
 */
export const UN_M49_NOT_ELECTED = {
	url: "https://unstats.un.org/unsd/methodology/m49/overview/",
	terms:
		"The United Nations grants permission to Users to visit the Site and to download and copy the information " +
		"for the User's personal, non-commercial use, without any right to resell or redistribute them or to compile or " +
		"create derivative works therefrom.",
	readAt: "https://www.un.org/en/about-us/terms-of-use",
}

/**
 * Reads the lock, or `null` when none has been written.
 */
export async function readSourceLock(): Promise<SourceLock | null> {
	const path = sourceLockPath()

	return (await pathExists(path)) ? readLocalJSONFile<SourceLock>(path) : null
}

const DOWNLOAD_TIMEOUT_MS = 120_000

/**
 * The result of downloading one source.
 */
export interface DownloadedSource {
	id: SourceID
	path: PathBuilder
	entry: SourceLockEntry
}

/**
 * Downloads one source to its data-root path and records what the server stated about it.
 */
export async function retrieveRegistrySource(source: SourceDefinition, client: APIClient): Promise<DownloadedSource> {
	const response = await client.fetch<string>({ url: source.url })
	const path = sourcePath(source)
	const body = typeof response.data === "string" ? response.data : stringifyJSON(response.data)

	await writeLocalFile(body, path)

	const sha256 = await sha256File(path)
	const headers = response.headers as Record<string, string | undefined>
	const publication = headers["last-modified"] ?? headers["etag"] ?? "unstated"
	const bytes = Buffer.byteLength(body)

	return {
		id: source.id,
		path,
		entry: { url: source.url, sha256, bytes, publication, terms: source.terms, feeds: source.feeds },
	}
}

/**
 * Creates the client the downloads share: three attempts, a two-minute idle timeout, text bodies.
 */
export function createRegistrySourceClient(): APIClient {
	return new APIClient({
		displayName: "registry sources",
		retry: { maxAttempts: 3 },
		axios: {
			headers: {
				"User-Agent": "mailwoman-registry/0.1 (https://github.com/sister-software/mailwoman)",
				Accept: "text/csv, application/sparql-results+json, application/json",
				"Accept-Encoding": "gzip",
			},
			timeout: DOWNLOAD_TIMEOUT_MS,
			responseType: "text",
			transitional: { silentJSONParsing: false },
		},
	})
}

/**
 * Downloads every elected source.
 *
 * With `repin`, the lock is rewritten from what was downloaded.
 * Without it, a downloaded digest that differs from the lock is an error naming the source,
 * because the build would otherwise read bytes the lock doesn't describe.
 */
export async function retrieveRegistrySources(options: { repin: boolean }): Promise<SourceLock> {
	const client = createRegistrySourceClient()
	const existing = await readSourceLock()
	const downloaded: DownloadedSource[] = []

	for (const source of SOURCES.filter((candidate) => candidate.terms.elected)) {
		const result = await retrieveRegistrySource(source, client)
		const locked = existing?.sources[source.id]

		if (!options.repin && locked && locked.sha256 !== result.entry.sha256) {
			throw new Error(
				`${source.id}: downloaded ${result.entry.sha256} (${result.entry.bytes} bytes), lock holds ${locked.sha256} ` +
					`(${locked.bytes} bytes). Pass --repin to accept the new publication.`
			)
		}

		downloaded.push(result)
	}

	const lock: SourceLock = {
		profile: OPEN_PROFILE,
		sources: Object.fromEntries(downloaded.map((item) => [item.id, item.entry])) as SourceLock["sources"],
		$notElected: { "unsd-m49": UN_M49_NOT_ELECTED },
	}

	if (options.repin || !existing) {
		await writeLocalJSONFile(lock, sourceLockPath())
	}

	return lock
}
