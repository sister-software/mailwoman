// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The landmark layer: Wikidata places keyed by every name and alias they're written with,
 *   ranked by the number of Wikipedia language editions that describe them.
 *   The source is CC0, so the database may ship.
 */

import type { LandmarkHit, LandmarkLookup } from "@mailwoman/core/resolver"
import { OutcomeLayer, type OutcomeQuery, refuseMissingOutcomeTables } from "@mailwoman/core/resolver/outcome"
import { allRows } from "@mailwoman/core/utils"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sql, type Kysely } from "kysely"
import type { PathBuilderLike } from "path-ts"

import { LANDMARK_BY_NAME_SQL, landmarkHitsFromRows, landmarkNameKey, type LandmarkNameTable } from "#landmark/rows"
import { missingOutcomeTablesIn, OutcomeMembershipReader, outcomeAdmitPredicate } from "#outcome/memberships"
import type { LandmarkOutcomeDatabase } from "#outcome/schema"
import { prepareAll, type PreparedAll } from "#sqlite-utils"

export interface LandmarkDatabase extends LandmarkOutcomeDatabase {
	landmark_name: LandmarkNameTable
}

/**
 * The column order the build's positional insert writes.
 */
export const LANDMARK_NAME_COLUMNS = [
	"name_key",
	"qid",
	"name",
	"kind",
	"country",
	"latitude",
	"longitude",
	"sitelinks",
	"code",
	"is_primary",
	"importance",
	"h3_cell",
] as const satisfies ReadonlyArray<keyof LandmarkNameTable>

/**
 * Creates the table.
 *
 * Rows cluster by name, because every read is a probe of one name.
 */
export async function createLandmarkTables(db: Kysely<LandmarkDatabase>): Promise<void> {
	await db.schema
		.createTable("landmark_name")
		.addColumn("name_key", "text", (c) => c.notNull())
		.addColumn("qid", "text", (c) => c.notNull())
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("kind", "text", (c) => c.notNull())
		.addColumn("country", "text")
		.addColumn("latitude", "real", (c) => c.notNull())
		.addColumn("longitude", "real", (c) => c.notNull())
		.addColumn("sitelinks", "integer", (c) => c.notNull())
		.addColumn("code", "text")
		.addColumn("is_primary", "integer", (c) => c.notNull())
		.addColumn("importance", "real")
		.addColumn("h3_cell", "integer")
		.addPrimaryKeyConstraint("landmark_name_pk", ["name_key", "qid"])
		.modifyEnd(sql`without rowid`)
		.execute()
}

/**
 * Returns whether an alias is an identifier code rather than a word:
 * two to five upper-case letters or digits.
 */
export function isLandmarkCode(alias: string): boolean {
	return /^[\p{Lu}\d]{2,5}$/u.test(alias)
}

/**
 * Reads a sealed landmark database.
 */
export class LandmarkSqliteLookup implements LandmarkLookup, Disposable {
	readonly #db: DatabaseClient<LandmarkDatabase>

	readonly #byName: PreparedAll<[nameKey: string], LandmarkNameTable>

	readonly #layer: string
	readonly #missingOutcomeTables: readonly string[]
	readonly #outcomes: OutcomeMembershipReader | null

	/**
	 * `layer` names the database in each outcome member's source and in a refusal:
	 * `landmarks` for the Wikidata layer, `openstreetmap` for the OpenStreetMap place layer.
	 */
	constructor(path: PathBuilderLike, layer: string = OutcomeLayer.Landmarks) {
		this.#db = new DatabaseClient<LandmarkDatabase>(path, { readOnly: true })

		this.#byName = prepareAll(this.#db, LANDMARK_BY_NAME_SQL)
		this.#layer = layer
		this.#missingOutcomeTables = missingOutcomeTablesIn(this.#db)
		this.#outcomes = OutcomeMembershipReader.open(this.#db, { recordColumn: "qid", layer })
	}

	/**
	 * With `outcome`, each hit holds its outcome set, and `admit` is a predicate of the read.
	 *
	 * @throws {OutcomeRequestError} For an outcome query against a database without the outcome tables.
	 */
	find(name: string, outcome?: OutcomeQuery): LandmarkHit[] {
		const key = landmarkNameKey(name)

		if (!outcome) return landmarkHitsFromRows(this.#byName(key), name)

		refuseMissingOutcomeTables(`the ${this.#layer} database`, this.#missingOutcomeTables)

		const rows = outcome.admit ? this.#admittedRows(key, outcome.admit) : this.#byName(key)

		// A landmark row's defaults are keyed by its `kind`, as a candidate row's are by its placetype.
		return landmarkHitsFromRows(rows, name).map((hit) => ({
			...hit,
			outcomes: this.#outcomes!.read(hit.qid, hit.kind, outcome),
		}))
	}

	missingOutcomeTables(): readonly string[] {
		return this.#missingOutcomeTables
	}

	#admittedRows(key: string, admit: readonly number[]): LandmarkNameTable[] {
		const predicate = outcomeAdmitPredicate(admit, "qid", "landmark_name.qid", "landmark_name.kind")
		const [select, order] = LANDMARK_BY_NAME_SQL.split(" ORDER BY ")

		return allRows<LandmarkNameTable>(
			this.#db.prepare(`${select} AND ${predicate.sql} ORDER BY ${order}`),
			key,
			...predicate.params
		)
	}

	[Symbol.dispose](): void {
		this.#db[Symbol.dispose]()
	}
}
