// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Writes the corpus street index from street lines.
 */

import { foldStreetSurface } from "@mailwoman/resolver"
import { buildSealedArtifact } from "@mailwoman/sqlite/sealed/build"
import type { PathBuilderLike } from "path-ts"

import { createStreetNameTable, STREET_NAME_COLUMNS, type StreetIndexDatabase } from "#street-index/schema"

/**
 * One street line a premise register publishes.
 */
export interface StreetLine {
	country: string
	street: string
	locality?: string | null
}

/**
 * What one write read and kept.
 */
export interface StreetIndexWriteCount {
	/**
	 * Street lines read before folding.
	 */
	read: number
	/**
	 * Rows written, one per distinct folded (country, street, locality).
	 */
	written: number
	byCountry: Map<string, number>
}

/**
 * Rows inserted per transaction.
 */
const INSERT_BATCH_ROWS = 50_000

/**
 * Write a sealed street index at `out` from `lines`.
 *
 * Each street and locality is folded with `foldStreetSurface`, the fold the reader
 * applies to a probe, and a folded triple already written is skipped.
 */
export async function writeStreetIndex(
	lines: Iterable<StreetLine> | AsyncIterable<StreetLine>,
	out: PathBuilderLike
): Promise<StreetIndexWriteCount> {
	const count: StreetIndexWriteCount = { read: 0, written: 0, byCountry: new Map() }

	await buildSealedArtifact<StreetIndexDatabase, StreetIndexWriteCount, void>({
		out,
		createTables: (database) => createStreetNameTable(database),
		ingest: async (database) => {
			const insert = database.prepare(
				`INSERT OR IGNORE INTO street_name (${STREET_NAME_COLUMNS.join(", ")}) VALUES (?, ?, ?)`
			)

			let pending = 0

			database.exec("BEGIN")

			for await (const line of lines) {
				count.read++
				const name = foldStreetSurface(line.street)

				if (!name) continue
				const country = line.country.toUpperCase()

				if (Number(insert.run(country, name, foldStreetSurface(line.locality ?? "")).changes) > 0) {
					count.written++
					count.byCountry.set(country, (count.byCountry.get(country) ?? 0) + 1)
				}

				if (++pending >= INSERT_BATCH_ROWS) {
					database.exec("COMMIT")
					database.exec("BEGIN")
					pending = 0
				}
			}

			database.exec("COMMIT")

			return count
		},
		finish: async () => undefined,
	})

	return count
}
