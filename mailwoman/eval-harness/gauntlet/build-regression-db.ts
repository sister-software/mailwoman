/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the curated regression Gauntlet (`$MAILWOMAN_DATA_ROOT/gauntlet/regression.db`) from the
 *   committed seed (`cases/<cc>/*.jsonl`). Build-on-copy: write a temp DB, then swap it into place.
 *
 *   Row order in the DB is the loader's order (country dir, then case id) — not the pre-2026-08-05
 *   chronological array order. Checked, not assumed: the regression runner reads every row; the ablation
 *   layer's `SELECT` carries `.orderBy("id")`, so `--limit N` samples the same N rows either way; and
 *   `ablationBoardID` hashes a SORTED fingerprint. What changes is the order the regression runner PRINTS its
 *   per-case lines in, which is why the migration's graded receipt sorted before diffing.
 *
 *   Run: mailwoman eval gauntlet-build regression-db
 */

import { existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { dataRootPath, swapDatabaseIntoPlace } from "@mailwoman/core/utils"

import { CASES_DIR, loadRegressionCases, regressionCorpusHash } from "./cases/load.ts"
import { assertCorpusIsNonEmpty, writeCorpusStamp } from "./corpus-stamp.ts"
import { createGauntletMetaTable, createGauntletTable, GAUNTLET_CASE_COLUMNS, type GauntletDatabase } from "./schema.ts"

/**
 * Where to read the corpus from and where to write the DB. Both default to the real ones; a test overrides them to
 * build a fixture-scale artifact without going near `$MAILWOMAN_DATA_ROOT`.
 */
export interface BuildRegressionDBOptions {
	casesDir?: string
	output?: string
}

/**
 * Build the curated regression DB from the committed seed and swap it into place.
 *
 * @throws When the loader resolves zero cases — see {@linkcode assertCorpusIsNonEmpty}. A build that prints "built"
 *   over an empty corpus is the 2026-08-06 failure, and it exits 0 today unless something refuses.
 */
export async function buildRegressionDB(options: BuildRegressionDBOptions = {}): Promise<void> {
	const casesDir = options.casesDir ?? CASES_DIR
	const cases = await loadRegressionCases(casesDir)

	assertCorpusIsNonEmpty(cases, casesDir)

	const output = options.output ?? dataRootPath("gauntlet", "regression.db")
	const tmp = `${output}.tmp-${process.pid}`

	mkdirSync(dirname(output), { recursive: true })

	if (existsSync(tmp)) {
		rmSync(tmp)
	}

	const db = new DatabaseSync(tmp)
	const kdb = new DatabaseClient<GauntletDatabase>({ database: db })
	await createGauntletTable(kdb)
	await createGauntletMetaTable(kdb)

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

	// The stamp goes in LAST and inside the same handle: an artifact that reached the swap without one would be
	// exactly the unattributable DB this guard exists to abolish.
	await writeCorpusStamp(kdb, cases)

	await kdb.destroy()

	swapDatabaseIntoPlace(tmp, output)

	console.log(`[gauntlet] built ${output} — ${cases.length} cases (corpus ${regressionCorpusHash(cases).slice(0, 12)})`)

	const kinds = new Map<string, number>()

	for (const c of cases) {
		kinds.set(`${c.country}/${c.addressKind}`, (kinds.get(`${c.country}/${c.addressKind}`) ?? 0) + 1)
	}

	console.log(`[gauntlet] coverage by kind: ${[...kinds].map(([k, n]) => `${k}=${n}`).join("  ")}`)
}
