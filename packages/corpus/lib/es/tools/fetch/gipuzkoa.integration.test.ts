/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reaches `b5m.gipuzkoa.eus`. In the slow suite, so the fast suite stays offline.
 */

import { APIClient } from "@mailwoman/core/api"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { listZipEntries } from "@mailwoman/core/fs/zip"
import { describe, expect, it } from "vitest"

import {
	ES_GIPUZKOA_ARCHIVE_FILENAME,
	type GipuzkoaManifest,
	downloadGipuzkoa,
	readGipuzkoaPublication,
	resolveGipuzkoaArchive,
} from "#es/tools/fetch/gipuzkoa"
import { LIVE_PUBLISHER_TESTS } from "#test-kit"
import { readManifest } from "#tools/fetch/download"

/**
 * The archive is about 8 MB and the resolution costs two requests.
 */
const TIMEOUT_MS = 300_000

function liveClient(): APIClient {
	return new APIClient({ displayName: "es-gipuzkoa integration", retry: true })
}

describe.runIf(LIVE_PUBLISHER_TESTS)("resolveGipuzkoaArchive against b5m.gipuzkoa.eus", () => {
	it(
		"resolves the one entry's rel=alternate link to the province's archive",
		async () => {
			await using client = liveClient()

			const reference = await resolveGipuzkoaArchive(client)

			expect(reference.archiveURL).toMatch(/\.zip$/u)
			expect(reference.archiveURL.endsWith(ES_GIPUZKOA_ARCHIVE_FILENAME)).toBe(true)

			// The ISO 19139 record sits on the same entry under rel="describedby",
			// and resolving that instead would download metadata under a .zip name.
			expect(reference.archiveURL).not.toMatch(/metadata_inspire/u)

			const publication = await readGipuzkoaPublication(client, reference.archiveURL)

			// The freshness decision rests on this header, because the entry's own `<updated>`
			// has not moved since 2017 while the archive refreshes weekly.
			expect(publication.lastModified).not.toBeNull()
			expect(publication.reportedBytes).toBeGreaterThan(0)
		},
		TIMEOUT_MS
	)
})

describe.runIf(LIVE_PUBLISHER_TESTS)("downloadGipuzkoa against b5m.gipuzkoa.eus", () => {
	it(
		"writes the archive the adapter opens, and asks for it once over the same directory",
		async () => {
			await using scratch = await temporaryDirectory("mailwoman-gipuzkoa-live-")
			await using client = liveClient()

			expect(await downloadGipuzkoa(client, { outputDir: scratch.path })).toMatchObject({ fetched: 1, failed: 0 })

			const manifest = await readManifest<GipuzkoaManifest>(scratch.path("MANIFEST.json"))

			expect(manifest?.filename).toBe(ES_GIPUZKOA_ARCHIVE_FILENAME)
			expect(manifest?.bytes).toBeGreaterThan(0)
			expect(manifest?.sha256).toMatch(/^[0-9a-f]{64}$/u)
			expect(manifest?.last_modified).not.toBeNull()

			const members = await listZipEntries(scratch.path(ES_GIPUZKOA_ARCHIVE_FILENAME))
			const gml = members.filter((member) => member.name.toLowerCase().endsWith(".gml"))

			expect(gml).toHaveLength(1)

			expect(await downloadGipuzkoa(client, { outputDir: scratch.path })).toMatchObject({ fetched: 0, skipped: 1 })
		},
		TIMEOUT_MS
	)
})
