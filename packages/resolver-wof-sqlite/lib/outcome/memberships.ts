// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The reads of a compiled database's outcome tables, shared by the candidate table
 *   and the landmark layers.
 *
 *   A record's effective set is the join of `outcome_default`, one row per placetype
 *   default, and `record_outcome`, one row per explicit assertion.
 *   The candidate table keys `record_outcome` by `spr_id` and its defaults by the row's placetype.
 *
 *   A landmark layer keys `record_outcome` by `qid` and its defaults by the row's `kind`.
 */

import {
	OUTCOME_TABLES,
	outcomeKindOfID,
	type OutcomeMembership,
	unionOutcomes,
} from "@mailwoman/core/resolver/outcome"
import { isPresent } from "@mailwoman/core/values/objects"
import type { DatabaseClient } from "@mailwoman/sqlite/client"

import { hasTable, prepareAll, type PreparedAll } from "#sqlite-utils"

/**
 * How one database keys its outcome rows.
 */
export interface OutcomeKeying {
	/**
	 * The `record_outcome` column that holds the record's key: `spr_id` or `qid`.
	 */
	recordColumn: "spr_id" | "qid"
	/**
	 * The data layer's name, the prefix of each member's source.
	 */
	layer: string
}

/**
 * The outcome tables `db` lacks.
 */
export function missingOutcomeTablesIn<DB>(db: DatabaseClient<DB>): string[] {
	return OUTCOME_TABLES.filter((table) => !hasTable(db, table))
}

/**
 * The SQL predicate that keeps a row holding one of `ids`, by default or by assertion.
 *
 * `recordExpression` and `defaultKeyExpression` are SQL over the probed row: its record key
 * and the value `outcome_default.placetype` is compared with.
 */
export function outcomeAdmitPredicate(
	ids: readonly number[],
	recordColumn: OutcomeKeying["recordColumn"],
	recordExpression: string,
	defaultKeyExpression: string
): { sql: string; params: number[] } {
	// An empty admit list admits zero rows, and `IN ()` isn't valid SQL.
	if (!ids.length) return { sql: "0", params: [] }

	const list = ids.map(() => "?").join(",")

	return {
		sql:
			`(EXISTS (SELECT 1 FROM outcome_default od WHERE od.placetype = ${defaultKeyExpression} AND od.outcome_id IN (${list}))` +
			` OR EXISTS (SELECT 1 FROM record_outcome ro WHERE ro.${recordColumn} = ${recordExpression} AND ro.outcome_id IN (${list})))`,
		params: [...ids, ...ids],
	}
}

/**
 * Reads effective outcome sets from one database, caching each placetype's defaults.
 */
export class OutcomeMembershipReader {
	readonly #keying: OutcomeKeying
	readonly #defaults: PreparedAll<[key: string], { outcome_id: number }>
	readonly #asserted: PreparedAll<[record: string | number], { outcome_id: number; contested: number }>
	readonly #defaultCache = new Map<string, number[]>()

	private constructor(
		keying: OutcomeKeying,
		defaults: PreparedAll<[key: string], { outcome_id: number }>,
		asserted: PreparedAll<[record: string | number], { outcome_id: number; contested: number }>
	) {
		this.#keying = keying
		this.#defaults = defaults
		this.#asserted = asserted
	}

	/**
	 * A reader, or null when `db` lacks an outcome table.
	 */
	static open<DB>(db: DatabaseClient<DB>, keying: OutcomeKeying): OutcomeMembershipReader | null {
		if (missingOutcomeTablesIn(db).length) return null

		return new OutcomeMembershipReader(
			keying,
			prepareAll(db, "SELECT outcome_id FROM outcome_default WHERE placetype = ?"),
			prepareAll(db, `SELECT outcome_id, contested FROM record_outcome WHERE ${keying.recordColumn} = ?`)
		)
	}

	/**
	 * The effective set of one record: its placetype defaults and its explicit assertions.
	 *
	 * An id the vocabulary doesn't hold is left out, because the database may pin a
	 * newer revision than the generated table of this build.
	 */
	read(record: string | number, defaultKey: string): OutcomeMembership[] {
		let defaults = this.#defaultCache.get(defaultKey)

		if (!defaults) {
			defaults = this.#defaults(defaultKey).map((row) => Number(row.outcome_id))
			this.#defaultCache.set(defaultKey, defaults)
		}

		const fromDefaults: OutcomeMembership[] = defaults
			.map(outcomeKindOfID)
			.filter(isPresent)
			.map((outcome) => ({ outcome, contested: false, sources: [`${this.#keying.layer}:default`] }))

		const fromAssertions: OutcomeMembership[] = this.#asserted(record).flatMap((row) => {
			const outcome = outcomeKindOfID(Number(row.outcome_id))

			return outcome
				? [{ outcome, contested: Number(row.contested) === 1, sources: [`${this.#keying.layer}:asserted`] }]
				: []
		})

		return unionOutcomes(fromDefaults, fromAssertions)
	}
}
