// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Fetch GeoNames' parent-child hierarchy, `hierarchy.txt` inside `export/dump/hierarchy.zip`.
 *
 * Each row is `parentId`, `childId` and a type.
 * The type `ADM` marks the administrative hierarchy that the `<CC>.txt` admin codes
 * also encode, and any other value is a user-added relation.
 *
 * The former-division linker reads the rows whose parent is a historical division
 * (`ADM1H` through `ADM5H`, `PCLH`), which name the places that division contained.
 */

import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { makeDirectories, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { extractZipEntry } from "@mailwoman/core/fs/zip"
import { sha256File } from "@mailwoman/core/hash"

import type { BaseFetchOptions, FetchSummary } from "#tools/fetch/download"
import { downloadToFile, writeManifest } from "#tools/fetch/download"

const SLUG = "geonames-hierarchy"

const URL = "https://download.geonames.org/export/dump/hierarchy.zip"

/**
 * The file `hierarchy.zip` holds, and the name the fetch writes it under.
 */
export const GEONAMES_HIERARCHY_FILE = "hierarchy.txt"

export type FetchGeonamesHierarchyOptions = BaseFetchOptions

/**
 * Download `hierarchy.zip` into `<outRoot>/geonames-hierarchy/`, extract `hierarchy.txt`
 * and write a `MANIFEST.json` with its origin, sha256 and size.
 */
export async function fetchGeonamesHierarchy(
	options: FetchGeonamesHierarchyOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	const destDir = options.outRoot(SLUG)

	await makeDirectories(destDir)

	const zipDest = destDir("hierarchy.zip")
	const txtDest = destDir(GEONAMES_HIERARCHY_FILE)

	report?.(`=== ${SLUG}`)

	try {
		await downloadToFile({ url: URL, dest: zipDest, timeoutMs: 300_000, retries: 2, report })
		await extractZipEntry(zipDest, GEONAMES_HIERARCHY_FILE, txtDest)
	} catch (error) {
		report?.(`✗ ${SLUG}: ${error instanceof Error ? error.message : String(error)}`)

		return { fetched: 0, skipped: 0, failed: 1, failedCodes: [SLUG] }
	} finally {
		await removePathIfPresent(zipDest)
	}

	await writeManifest(destDir("MANIFEST.json"), {
		source: SLUG,
		source_url: URL,
		license: "CC-BY-4.0",
		attribution: "GeoNames",
		downloaded_at: new Date().toISOString(),
		files: [
			{
				filename: GEONAMES_HIERARCHY_FILE,
				sha256: await sha256File(txtDest),
				bytes: (await readLocalBuffer(txtDest)).byteLength,
			},
		],
	})

	return { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }
}
