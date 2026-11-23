// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The groups a training config's receipts require in training.
 *   A held-out draw must skip them.
 *
 *   A held-out freeze and the validation quota each take whole groups out of training.
 *   A group a receipt needs in train then fails that receipt after the re-split.
 *
 *   The prominent-place coverage receipt (#3156) needs each required place's train rows, and a
 *   `rendered-prominent-places` row shares its group's WOF record with that record's `wof-admin` rows.
 *   The v14 confirmation freeze and the v0.8.22 validation quota took 139 of 16,425 prominent
 *   places out of training that way, and the receipt failed 11 of 813 demand cells.
 *
 *   {@linkcode readRequiredTrainingGroups} reads those groups from the receipts a config declares.
 *   `heldout/dataset/freeze.run.ts` and `validation/quota.run.ts` both read it, load it with
 *   {@linkcode createRequiredGroupsTable}, test each group with {@linkcode requiredGroupSQL},
 *   and report what they skipped by country with {@linkcode describeRequiredGroupSkip}.
 *
 *   The prominent-place receipt's groups are read by WOF record ({@linkcode prominentPlaceRecordSQL}).
 *   A row of another source that writes the place keeps its own group,
 *   and a draw can still take that group.
 */

import { type DisposableDuckDB, type DuckDBLimits, escapeSQLString } from "@mailwoman/corpus/parquet/duckdb"
import type { TrainingConfig } from "@mailwoman/corpus/training/config/schema"
import type { RequiredGroupReceipt, RequiredGroupSkip } from "@mailwoman/corpus/utils/evaluation-groups"

import { readRequiredProminentPlaces } from "#tools/training/audits/prominent/coverage"
import { prominentPlaceRecordSQL } from "#tools/training/audits/prominent/records"
import { hostPath } from "#tools/training/sampler"

/**
 * The groups a config's receipts require in training, as the WOF records whose groups they are.
 */
export interface RequiredTrainingGroups {
	receipts: RequiredGroupReceipt[]
	/**
	 * Each required WOF record and its country.
	 */
	records: ReadonlyMap<number, string>
}

/**
 * Reads the groups every receipt `config` declares requires in training.
 *
 * For a config that declares no such receipt, `receipts` and `records` are empty.
 *
 * @throws As {@linkcode readRequiredProminentPlaces} does, when the places table doesn't match its record.
 */
export async function readRequiredTrainingGroups(
	config: { data: Pick<TrainingConfig["data"], "prominent_place_coverage" | "country_weights"> },
	limits?: DuckDBLimits
): Promise<RequiredTrainingGroups> {
	const places = config.data.prominent_place_coverage

	if (!places) return { receipts: [], records: new Map() }

	const read = await readRequiredProminentPlaces(hostPath(places), config.data.country_weights, limits)

	return {
		receipts: [
			{
				receipt: "prominent_place_coverage",
				places,
				places_sha256: read.record.places_sha256,
				required_places: read.places.length,
			},
		],
		records: new Map(read.places.map((place) => [place.spr_id, place.country])),
	}
}

/**
 * The table {@linkcode createRequiredGroupsTable} writes.
 */
const REQUIRED_RECORDS_TABLE = "required_training_records"

/**
 * Writes the required records into a temporary table on `db`, for {@linkcode requiredGroupSQL}.
 */
export async function createRequiredGroupsTable(
	db: DisposableDuckDB,
	required: Pick<RequiredTrainingGroups, "records">
): Promise<void> {
	await db.run(`CREATE OR REPLACE TEMP TABLE ${REQUIRED_RECORDS_TABLE} (id BIGINT PRIMARY KEY, country VARCHAR)`)

	const entries = [...required.records]

	for (let start = 0; start < entries.length; start += 5000) {
		const values = entries
			.slice(start, start + 5000)
			.map(([id, country]) => `(${id}, '${escapeSQLString(country)}')`)
			.join(", ")

		await db.run(`INSERT INTO ${REQUIRED_RECORDS_TABLE} VALUES ${values}`)
	}
}

/**
 * A DuckDB predicate, true when the group `group` evaluates to is one a receipt requires in training.
 *
 * It is never `NULL`, so `NOT` of it keeps every group of no required record.
 * The connection must hold the table {@linkcode createRequiredGroupsTable} writes.
 */
export function requiredGroupSQL(group: string): string {
	return `coalesce(${prominentPlaceRecordSQL(group)} IN (SELECT id FROM ${REQUIRED_RECORDS_TABLE}), false)`
}

/**
 * The record of one draw's skip, from the required groups and the per-country counts its pool held.
 */
export function requiredGroupSkip(
	required: RequiredTrainingGroups,
	byCountry: ReadonlyMap<string, number>
): RequiredGroupSkip {
	const sorted = [...byCountry].toSorted(([a], [b]) => a.localeCompare(b))

	return {
		receipts: required.receipts,
		requiredRecords: required.records.size,
		skippedGroups: sorted.reduce((sum, [, groups]) => sum + groups, 0),
		byCountry: Object.fromEntries(sorted),
	}
}

/**
 * The lines a tool prints for its skip.
 */
export function describeRequiredGroupSkip(skip: RequiredGroupSkip): string[] {
	if (!skip.receipts.length) return ["required training groups: the config declares no receipt that requires groups"]

	const receipts = skip.receipts.map((receipt) => `${receipt.receipt} (${receipt.required_places} required places)`)
	const countries = Object.entries(skip.byCountry).map(([country, groups]) => `${country} ${groups}`)

	return [
		`required training groups: ${receipts.join(", ")}; skipped ${skip.skippedGroups} groups the pool held`,
		...(countries.length ? [`  by country: ${countries.join(", ")}`] : []),
	]
}
