// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Lists the database files the public bucket stores, grouped by the path above their version directory.
 *
 *   Usage: node --env-file=.env packages/mailwoman/tools/dev-tools/cloudflare/databases.run.ts [--prefix <key prefix>]
 *
 *   A database file is a key ending in `.db`, `.sqlite`, `.bin`, `.pmtiles` or `.parquet`.
 *   The group is the key with its last two segments removed, so
 *   `mailwoman/addresses/us-tx/2026-11-10/lookup.db` groups under `mailwoman/addresses/us-tx`.
 *
 *   Each group prints its file count, total size and one example key.
 */

import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { listPublicBucketObjects } from "@mailwoman/gazetteer/tools/publish/public-bucket"

const { values } = parseArguments({ options: { prefix: { type: "string" } } })

/**
 * The file extensions treated as databases or byte-range-read data files.
 */
const DATABASE_EXTENSIONS = [".db", ".sqlite", ".bin", ".pmtiles", ".parquet"] as const

const objects = await listPublicBucketObjects({ prefix: values.prefix })
const databases = objects.filter((object) => DATABASE_EXTENSIONS.some((extension) => object.key.endsWith(extension)))
const groups = new Map<string, { files: number; bytes: number; example: string }>()

for (const object of databases) {
	const segments = object.key.split("/")
	const group = segments.slice(0, Math.max(1, segments.length - 2)).join("/")
	const entry = groups.get(group) ?? { files: 0, bytes: 0, example: object.key }

	entry.files++
	entry.bytes += object.bytes
	groups.set(group, entry)
}

console.log(`${objects.length} objects; ${databases.length} database files in ${groups.size} groups`)

for (const [group, entry] of [...groups].toSorted(([a], [b]) => a.localeCompare(b))) {
	console.log(`${group}\t${entry.files}\t${(entry.bytes / 1024 ** 3).toFixed(2)} GiB\t${entry.example}`)
}
