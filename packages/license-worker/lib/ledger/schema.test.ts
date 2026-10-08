/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The ledger's table interfaces are written by hand beside the migrations. This applies every migration in order to
 *   a fresh D1 and reads the resulting columns back, so an interface that drifts from the DDL fails here.
 */

import { env } from "cloudflare:workers"
import { beforeAll, expect, test } from "vitest"

import { LEDGER_COLUMNS, type LedgerColumnKind } from "#ledger/schema"
import { applyMigrations } from "#test/support/migrations"

interface TableInfoRow {
	name: string
	notnull: number
	dflt_value: string | null
	pk: number
}

/**
 * Tables D1 and SQLite keep for themselves.
 */
const INTERNAL_TABLE = /^(sqlite_|_cf_|d1_)/

beforeAll(async () => {
	await applyMigrations(env.LICENSE_LEDGER)
})

function kindOf(column: TableInfoRow): LedgerColumnKind {
	if (column.dflt_value !== null) return "generated"

	return column.notnull || column.pk ? "required" : "nullable"
}

async function migratedColumns(table: string): Promise<Record<string, LedgerColumnKind>> {
	// A table name cannot be bound as a parameter, and each one here comes from the migrated schema itself.
	const { results } = await env.LICENSE_LEDGER.prepare(`PRAGMA table_info(${table})`).all<TableInfoRow>()

	return Object.fromEntries(results.map((column) => [column.name, kindOf(column)]))
}

test("the migrations create exactly the tables the ledger schema declares", async () => {
	const { results } = await env.LICENSE_LEDGER.prepare(
		"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
	).all<{ name: string }>()

	const tables = results.map((row) => row.name).filter((name) => !INTERNAL_TABLE.test(name))

	expect(tables).toEqual(Object.keys(LEDGER_COLUMNS).toSorted())
})

test.each(Object.keys(LEDGER_COLUMNS))("the %s columns match the ledger schema", async (table) => {
	expect(await migratedColumns(table)).toEqual(LEDGER_COLUMNS[table as keyof typeof LEDGER_COLUMNS])
})
