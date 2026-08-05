/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the curated regression Gauntlet (`$MAILWOMAN_DATA_ROOT/gauntlet/regression.db`) from the
 *   committed seed (`cases/<cc>/*.jsonl`). Build-on-copy: write a temp DB, then swap it into place.
 *
 *   Row order in the DB is the loader's order (country dir, then case id) — not the pre-2026-08-05
 *   chronological array order. Nothing grades on it: the regression runner reads every row, and the ablation
 *   board id hashes a sorted fingerprint. The one consumer that SEES it is `ablation --limit N`, which slices
 *   the first N rows and so now samples alphabetically by country rather than by entry date.
 *
 *   Run: mailwoman eval gauntlet-build regression-db
 */

import { existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { dataRootPath, swapDatabaseIntoPlace } from "@mailwoman/core/utils"

import { loadRegressionCases } from "./cases/load.ts"
import { createGauntletTable, GAUNTLET_CASE_COLUMNS, type GauntletDatabase } from "./schema.ts"

/**
 * Build the curated regression DB from the committed seed and swap it into place.
 */
export async function buildRegressionDB(): Promise<void> {
	const cases = await loadRegressionCases()
	const output = dataRootPath("gauntlet", "regression.db")
	const tmp = `${output}.tmp-${process.pid}`

	mkdirSync(dirname(output), { recursive: true })

	if (existsSync(tmp)) {
		rmSync(tmp)
	}

	const db = new DatabaseSync(tmp)
	const kdb = new DatabaseClient<GauntletDatabase>({ database: db })
	await createGauntletTable(kdb)

	const insert = db.prepare(`INSERT INTO gauntlet_case VALUES (${GAUNTLET_CASE_COLUMNS.map(() => "?").join(", ")})`)

	for (const c of cases) {
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
			c.defaultCountry ?? null,
			c.addedAt,
			c.bugRef ?? null,
			c.note ?? null,
			c.ablationExpect ? JSON.stringify(c.ablationExpect) : null
		)
	}

	await kdb.destroy()

	swapDatabaseIntoPlace(tmp, output)

	console.log(`[gauntlet] built ${output} — ${cases.length} cases`)

	const kinds = new Map<string, number>()

	for (const c of cases) {
		kinds.set(`${c.country}/${c.addressKind}`, (kinds.get(`${c.country}/${c.addressKind}`) ?? 0) + 1)
	}

	console.log(`[gauntlet] coverage by kind: ${[...kinds].map(([k, n]) => `${k}=${n}`).join("  ")}`)
}
