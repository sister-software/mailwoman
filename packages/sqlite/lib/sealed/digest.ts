// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file A digest of a database's table contents, equal for two databases that hold the same rows.
 *
 *   A file's md5 differs between two builds of the same rows, because page layout, free pages and a
 *   build timestamp all reach the bytes. This digest reads rows in key order instead, so a cached
 *   build and a build from scratch compare equal exactly when every table holds the same rows.
 *
 *   `@mailwoman/core` depends on this package, so hashing comes from `node:crypto` here, the module
 *   core's hash helpers wrap.
 */

import { createHash, type Hash } from "node:crypto"

import type { DatabaseClient } from "#client"
import { listTables } from "#introspection"

/**
 * The columns a build writes from its own clock or checkout, left out of every digest by default.
 */
export const BUILD_STAMP_COLUMNS: Readonly<Record<string, readonly string[]>> = {
	layer_manifest: ["created_at", "build_sha"],
}

/**
 * What a content digest leaves out, and how it splits a table by country.
 */
export interface ContentDigestSpec {
	/**
	 * Tables left out by name, beside the `sqlite_*` tables and every virtual table's shadow tables.
	 */
	excludeTables?: readonly string[]
	/**
	 * Columns left out per table.
	 * Defaults to {@linkcode BUILD_STAMP_COLUMNS}.
	 */
	excludeColumns?: Readonly<Record<string, readonly string[]>>
	/**
	 * A column whose value also splits each table that has it into one digest per value,
	 * so a change can be traced to the countries it touched.
	 */
	countryColumn?: string
}

/**
 * One table's digest.
 */
export interface TableContentDigest {
	rows: number
	digest: string
	/**
	 * One digest per value of the spec's country column, when the table has that column.
	 */
	byCountry?: Record<string, string>
}

/**
 * A database's content digest: one digest per table and a root digest over them all.
 */
export interface DatabaseContentDigest {
	root: string
	tables: Record<string, TableContentDigest>
}

interface ColumnInfo {
	name: string
	pk: number
}

/**
 * Separates the fields of one row in the hash input.
 */
const FIELD_SEPARATOR = "\u0000"

/**
 * Ends one row in the hash input.
 */
const ROW_SEPARATOR = "\u0001"

/**
 * The digest of every table's rows, read in primary-key order, or in the order of all columns
 * for a table without a primary key, so insertion order and page layout leave it unchanged.
 *
 * A virtual table is read through its own rows, in rowid order, and its shadow
 * tables (`<name>_data`, `<name>_node` and the rest) are left out, because they
 * store an index layout that depends on insertion order.
 * Each value is tagged with its storage type, so the integer `1` and the real `1.0` digest differently.
 */
export function databaseContentDigest<DB>(db: DatabaseClient<DB>, spec: ContentDigestSpec = {}): DatabaseContentDigest {
	const excludeColumns = spec.excludeColumns ?? BUILD_STAMP_COLUMNS
	const excludeTables = new Set(spec.excludeTables)

	const virtualTables = (
		db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'")
			.all() as Array<{
			name: string
		}>
	).map((row) => row.name)

	const isShadow = (table: string) => virtualTables.some((name) => table.startsWith(`${name}_`))
	const tables: Record<string, TableContentDigest> = {}

	for (const table of listTables(db)) {
		if (table.startsWith("sqlite_") || excludeTables.has(table) || isShadow(table)) continue

		tables[table] = digestTable(db, table, {
			virtual: virtualTables.includes(table),
			excluded: new Set(excludeColumns[table]),
			countryColumn: spec.countryColumn,
		})
	}

	const root = createHash("sha256")

	for (const [table, { digest }] of Object.entries(tables)) {
		root.update(`${table}${FIELD_SEPARATOR}${digest}${ROW_SEPARATOR}`)
	}

	return { root: root.digest("hex"), tables }
}

/**
 * The digest of one table, with its per-country split.
 */
function digestTable<DB>(
	db: DatabaseClient<DB>,
	table: string,
	options: { virtual: boolean; excluded: ReadonlySet<string>; countryColumn: string | undefined }
): TableContentDigest {
	const columnInfo: ColumnInfo[] = db
		.prepare(`PRAGMA table_info("${table}")`)
		.all()
		.map((row) => ({ name: String(row["name"]), pk: Number(row["pk"]) }))

	const columns = columnInfo.map((column) => column.name).filter((name) => !options.excluded.has(name))

	const keyColumns = columnInfo
		.filter((column) => column.pk > 0)
		.toSorted((a, b) => a.pk - b.pk)
		.map((column) => column.name)

	const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`

	const selected = (options.virtual ? ["rowid", ...columns] : columns).flatMap((name) => [
		`typeof(${quoted(name)})`,
		quoted(name),
	])

	const order = options.virtual ? ["rowid"] : keyColumns.length ? keyColumns : columns
	const countryIndex = options.countryColumn ? columns.indexOf(options.countryColumn) : -1
	const offset = options.virtual ? 1 : 0

	const statement = db.prepare(
		`SELECT ${selected.join(", ")} FROM ${quoted(table)} ORDER BY ${order.map(quoted).join(", ")}`
	)

	// A 64-bit id past 2^53 loses precision as a JavaScript number.
	statement.setReadBigInts(true)
	statement.setReturnArrays(true)

	const hash = createHash("sha256")
	const byCountry = new Map<string, Hash>()
	let rows = 0

	for (const row of statement.iterate() as Iterable<unknown[]>) {
		const encoded = encodeRow(row)

		hash.update(encoded)

		rows++

		if (countryIndex >= 0) {
			const country = String(row[2 * (countryIndex + offset) + 1] ?? "")
			const countryHash = byCountry.get(country) ?? createHash("sha256")

			countryHash.update(encoded)
			byCountry.set(country, countryHash)
		}
	}

	return {
		rows,
		digest: hash.digest("hex"),
		...(countryIndex >= 0
			? {
					byCountry: Object.fromEntries(
						[...byCountry].toSorted(([a], [b]) => a.localeCompare(b)).map(([country, h]) => [country, h.digest("hex")])
					),
				}
			: {}),
	}
}

/**
 * One row as hash input: each value after its SQLite storage type, with blobs in hex.
 */
function encodeRow(row: readonly unknown[]): string {
	const fields: string[] = []

	for (let index = 0; index < row.length; index += 2) {
		const type = String(row[index])
		const value = row[index + 1]

		fields.push(`${type}:${value instanceof Uint8Array ? Buffer.from(value).toString("hex") : String(value)}`)
	}

	return `${fields.join(FIELD_SEPARATOR)}${ROW_SEPARATOR}`
}
