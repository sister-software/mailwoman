/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the curated regression Gauntlet (`$MAILWOMAN_DATA_ROOT/gauntlet/regression.db`) from the
 *   committed seed (`cases/regression.ts`). Build-on-copy: write a temp DB, then swap it into place.
 *
 *   Run: node scripts/eval/gauntlet/build-regression-db.ts
 */

import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { dataRootPath } from "@mailwoman/core/utils"

import { REGRESSION_CASES } from "./cases/regression.ts"
import { createGauntletTable, GAUNTLET_CASE_COLUMNS, type GauntletDatabase } from "./schema.ts"

const output = dataRootPath("gauntlet", "regression.db")
const tmp = `${output}.tmp-${process.pid}`

mkdirSync(dirname(output), { recursive: true })

if (existsSync(tmp)) rmSync(tmp)

const db = new DatabaseSync(tmp)
const kdb = new DatabaseClient<GauntletDatabase>({ database: db })
await createGauntletTable(kdb)

const insert = db.prepare(`INSERT INTO gauntlet_case VALUES (${GAUNTLET_CASE_COLUMNS.map(() => "?").join(", ")})`)

for (const c of REGRESSION_CASES) {
	// Positional, in GAUNTLET_CASE_COLUMNS order.
	insert.run(
		c.id,
		c.input,
		c.source,
		c.addressKind,
		c.country,
		c.status,
		c.expectComponents ? JSON.stringify(c.expectComponents) : null,
		c.expectPlaceID ?? null,
		c.expectPlaceName ?? null,
		c.expectLat ?? null,
		c.expectLon ?? null,
		c.expectToleranceM ?? null,
		c.expectTier ?? null,
		c.addedAt,
		c.bugRef ?? null,
		c.note ?? null
	)
}
await kdb.destroy()

if (existsSync(output)) renameSync(output, `${output}.prev`)
renameSync(tmp, output)

if (existsSync(`${output}.prev`)) rmSync(`${output}.prev`)

console.log(`[gauntlet] built ${output} — ${REGRESSION_CASES.length} cases`)
const kinds = new Map<string, number>()

for (const c of REGRESSION_CASES)
	kinds.set(`${c.country}/${c.addressKind}`, (kinds.get(`${c.country}/${c.addressKind}`) ?? 0) + 1)
console.log(`[gauntlet] coverage by kind: ${[...kinds].map(([k, n]) => `${k}=${n}`).join("  ")}`)
