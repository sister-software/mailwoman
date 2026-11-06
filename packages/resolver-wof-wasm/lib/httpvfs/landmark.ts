// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { LandmarkHit, LandmarkLookup } from "@mailwoman/core/resolver"
import {
	LANDMARK_BY_NAME_SQL,
	landmarkHitsFromRows,
	landmarkNameKey,
	type LandmarkNameTable,
} from "@mailwoman/resolver-wof-sqlite/landmark/rows"

import type { RangeDatabase } from "#httpvfs/database"

/**
 * Reads a sealed landmark database over range requests, as a Worker reads it from R2.
 *
 * `limit` bounds the rows one name reads, because OpenStreetMap holds thousands
 * of rows under its commonest names.
 */
export class RangeLandmarkLookup implements LandmarkLookup {
	readonly #database: RangeDatabase

	readonly #limit: number

	constructor(database: RangeDatabase, limit: number) {
		this.#database = database
		this.#limit = limit
	}

	async find(name: string): Promise<LandmarkHit[]> {
		const rows = await this.#database.query<LandmarkNameTable>(`${LANDMARK_BY_NAME_SQL} LIMIT ?`, [
			landmarkNameKey(name),
			this.#limit,
		])

		return landmarkHitsFromRows(rows, name)
	}
}
