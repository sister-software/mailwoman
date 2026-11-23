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
 *   A row of another record or source that writes the place keeps its own group.
 *   {@linkcode withRequiredFormGroups} adds those groups from a corpus's train rows, by the receipt's
 *   own match, so the reserve draw (`freeze.run.ts --reserve-groups-per-country`) skips them too.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { allKeyed } from "@mailwoman/core/promises"
import { type DisposableDuckDB, type DuckDBLimits, escapeSQLString, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import type { TrainingConfig } from "@mailwoman/corpus/training/config/schema"
import type { RequiredGroupReceipt, RequiredGroupSkip } from "@mailwoman/corpus/utils/evaluation-groups"
import { PathBuilder } from "path-ts"

import {
	createProminentCoverageTables,
	epochRates,
	readEpochMeasure,
	readRequiredFormGroups,
	readRequiredProminentPlaces,
} from "#tools/training/audits/prominent/coverage"
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
	/**
	 * Groups of another record or source whose train rows write a required form, by the
	 * receipt's match, with the country of the form, from {@linkcode withRequiredFormGroups}.
	 * `null` when no corpus was read for them.
	 */
	formGroups: ReadonlyMap<string, string> | null
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

	if (!places) return { receipts: [], records: new Map(), formGroups: null }

	const read = await readRequiredProminentPlaces(hostPath(places), config.data.country_weights, limits)

	return {
		receipts: [
			{
				receipt: "prominent_place_coverage",
				places,
				places_sha256: read.record.places_sha256,
				required_places: read.places.length,
				writable_places: read.writable.length,
			},
		],
		// A required place's groups, and a writable decile-1 place's.
		// The recipe's rows for the latter close a demand cell.
		records: new Map([...read.places, ...read.writable].map((place) => [place.spr_id, place.country])),
		formGroups: null,
	}
}

/**
 * Adds to `required` every group of `manifest`'s train rows that writes a required form
 * by the prominent-place receipt's own match ({@linkcode readRequiredFormGroups}):
 * a namesake record's `wof-admin` group or another source's group can be the only train
 * rows of a place's form, and a draw that takes it fails the receipt.
 *
 * It scans the corpus's short admin train rows with their groups and builds the
 * receipt's tables over `config`'s epoch on that corpus.
 *
 * A config that declares no receipt adds no group.
 */
export async function withRequiredFormGroups(
	required: RequiredTrainingGroups,
	config: TrainingConfig,
	manifest: string,
	options: { limits?: DuckDBLimits; log?: (line: string) => void } = {}
): Promise<RequiredTrainingGroups> {
	const places = config.data.prominent_place_coverage

	if (!places) return { ...required, formGroups: new Map() }

	const {
		places: { scanShortAdminRows },
		native: { mtfNode },
	} = await allKeyed({
		places: import("#tools/dev-tools/corpus/prominent/places"),
		native: import("@mailwoman/mtf/tools/sampler/native"),
	})

	await using scratch = await temporaryDirectory("mailwoman-required-form-groups-")

	await scanShortAdminRows({
		manifest,
		out: scratch.path.toString(),
		groups: true,
		limits: options.limits,
		log: options.log,
	})

	const corpusDir = PathBuilder.from(manifest).dirname().toString()
	const epoch = await readEpochMeasure(await mtfNode(), config, { corpusDir, limits: options.limits })

	using db = await openDuckDB(options.limits)

	await createProminentCoverageTables(
		db,
		hostPath(places),
		scratch.path("short-admin-rows.parquet").toString(),
		epochRates(epoch)
	)

	const groups = await readRequiredFormGroups(db)

	return { ...required, formGroups: new Map(groups.map(({ group, country }) => [group, country])) }
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
	required: Pick<RequiredTrainingGroups, "records"> & Partial<Pick<RequiredTrainingGroups, "formGroups">>
): Promise<void> {
	await db.run(`CREATE OR REPLACE TEMP TABLE ${REQUIRED_RECORDS_TABLE} (id BIGINT PRIMARY KEY, country VARCHAR)`)
	await db.run(`CREATE OR REPLACE TEMP TABLE ${REQUIRED_FORM_GROUPS_TABLE} (g VARCHAR PRIMARY KEY, country VARCHAR)`)

	const insert = async (table: string, rows: string[]) => {
		for (let start = 0; start < rows.length; start += 5000) {
			await db.run(`INSERT INTO ${table} VALUES ${rows.slice(start, start + 5000).join(", ")}`)
		}
	}

	await insert(
		REQUIRED_RECORDS_TABLE,
		[...required.records].map(([id, country]) => `(${id}, '${escapeSQLString(country)}')`)
	)

	await insert(
		REQUIRED_FORM_GROUPS_TABLE,
		[...(required.formGroups ?? [])].map(
			([group, country]) => `('${escapeSQLString(group)}', '${escapeSQLString(country)}')`
		)
	)
}

/**
 * The table of {@linkcode RequiredTrainingGroups.formGroups} {@linkcode createRequiredGroupsTable} writes.
 */
const REQUIRED_FORM_GROUPS_TABLE = "required_training_form_groups"

/**
 * A DuckDB predicate, true when the group `group` evaluates to is one a receipt requires in
 * training: a required place's record, or a group whose train rows write a required form.
 *
 * It is never `NULL`, so `NOT` of it keeps every other group.
 * The connection must hold the tables {@linkcode createRequiredGroupsTable} writes.
 */
export function requiredGroupSQL(group: string): string {
	return (
		`(coalesce(${prominentPlaceRecordSQL(group)} IN (SELECT id FROM ${REQUIRED_RECORDS_TABLE}), false) OR ` +
		`coalesce(${group} IN (SELECT g FROM ${REQUIRED_FORM_GROUPS_TABLE}), false))`
	)
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
		...(required.formGroups ? { requiredFormGroups: required.formGroups.size } : {}),
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

	const formGroups =
		skip.requiredFormGroups == null
			? ""
			: `, and ${skip.requiredFormGroups} groups whose train rows write a required form`

	return [
		`required training groups: ${receipts.join(", ")}${formGroups}; skipped ${skip.skippedGroups} groups the pool held`,
		...(countries.length ? [`  by country: ${countries.join(", ")}`] : []),
	]
}
