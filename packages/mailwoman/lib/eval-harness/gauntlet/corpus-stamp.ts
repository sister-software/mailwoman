/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The freshness interface between the committed corpus (`cases/<cc>/*.jsonl`) and its built artifact
 *   (`$MAILWOMAN_DATA_ROOT/gauntlet/regression.db`). The builder stamps what it wrote. Every runner that
 *   grades against the DB refuses when the stamp disagrees with the corpus on disk right now.
 *
 *   Two guards deliberately differ in kind: content (`corpus_hash` against the live {@linkcode regressionCorpusHash})
 *   catches a stale artifact, while emptiness refuses a zero-row corpus outright ({@linkcode assertCorpusIsNonEmpty}),
 *   because an empty loader agrees with itself and a hash comparison cannot see it.
 */

import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { sql } from "kysely"
import type { PathBuilderLike } from "path-ts"

import { CASES_DIR, loadRegressionCases, regressionCorpusHash } from "#eval-harness/gauntlet/cases/load"
import type { SeedCase } from "#eval-harness/gauntlet/cases/seed-case"
import {
	GAUNTLET_META_ROW_ID,
	GAUNTLET_META_TABLE,
	type GauntletDatabase,
	type GauntletMetaTable,
} from "#eval-harness/gauntlet/schema"

/**
 * The stamp a built `regression.db` carries, or `null` when the DB predates the stamp entirely.
 */
export type CorpusStamp = Pick<GauntletMetaTable, "corpus_hash" | "case_count" | "built_at">

/**
 * Refuse a corpus with no rows, naming the directory that produced none.
 *
 * A compiled tree pointing at a `cases/` directory with no country dirs loads cleanly
 * and builds a valid empty DB that grades 0/0 and passes.
 * A hash comparison cannot catch that case.
 */
export function assertCorpusIsNonEmpty(rows: readonly SeedCase[], dir: PathBuilderLike = CASES_DIR): void {
	if (rows.length) return

	throw new Error(
		`[gauntlet] the corpus loader resolved ZERO cases under ${dir} — refusing to build an empty regression.db.\n` +
			`This is the stale-compiled-tree shape (2026-08-06): the loader in use is not reading the committed ` +
			`cases/<cc>/*.jsonl. Run \`yarn compile\` and rebuild, or check that ${dir} is the corpus you meant.`
	)
}

/**
 * Write (or replace) the one-row build stamp, inside the builder and against
 * the same handle that wrote the cases.
 */
export async function writeCorpusStamp(
	kdb: DatabaseClient<GauntletDatabase>,
	rows: readonly SeedCase[],
	now: Date = new Date()
): Promise<void> {
	await kdb
		.insertInto(GAUNTLET_META_TABLE)
		.values({
			id: GAUNTLET_META_ROW_ID,
			corpus_hash: regressionCorpusHash(rows),
			case_count: rows.length,
			built_at: now.toISOString(),
		})
		.execute()
}

/**
 * Read the stamp out of a built DB; `null` means the table is absent,
 * as in a DB built before the stamp existed.
 */
export async function readCorpusStamp(kdb: DatabaseClient<GauntletDatabase>): Promise<CorpusStamp | null> {
	// Probe for presence first because selecting from a missing table throws a driver error.
	// Branching on error prose would make the guard unreliable.
	const present = await sql<{
		name: string
	}>`select name from sqlite_master where type = 'table' and name = ${GAUNTLET_META_TABLE}`.execute(kdb)

	if (!present.rows.length) return null

	const row = await kdb
		.selectFrom(GAUNTLET_META_TABLE)
		.select(["corpus_hash", "case_count", "built_at"])
		.where("id", "=", GAUNTLET_META_ROW_ID)
		.executeTakeFirst()

	return row ?? null
}

/**
 * Throw unless the DB's stamp matches the corpus committed on disk right now. the message
 * names both hashes and the likely cause, because an artifact older than the corpus
 * wants a rebuild while a build from a stale `out/` wants a recompile first.
 *
 * @param kdb An open handle on the built DB.
 * @param liveRows The corpus as committed.
 * Injectable so a test can pose a different state without touching the repo's own `cases/`.
 */
export async function assertCorpusStampFresh(
	kdb: DatabaseClient<GauntletDatabase>,
	liveRows?: readonly SeedCase[]
): Promise<void> {
	const stamp = await readCorpusStamp(kdb)
	const rows = liveRows ?? (await loadRegressionCases())
	const liveHash = regressionCorpusHash(rows)

	if (!stamp) {
		throw new Error(
			`[gauntlet] regression.db carries no corpus stamp (pre-2026-08-06 artifact) — refusing to grade against it.\n` +
				`  live corpus: ${liveHash} (${rows.length} cases)\n` +
				`  Rebuild it: yarn compile && node mailwoman/out/cli.js eval gauntlet-build regression-db`
		)
	}

	if (stamp.corpus_hash === liveHash) return

	throw new Error(
		`[gauntlet] regression.db was built from a DIFFERENT corpus than the one committed on disk — refusing to grade.\n` +
			`  db stamp:    ${stamp.corpus_hash} (${stamp.case_count} cases, built ${stamp.built_at})\n` +
			`  live corpus: ${liveHash} (${rows.length} cases)\n` +
			`  Likely cause: the DB predates your edits to cases/<cc>/*.jsonl, or it was built from a stale compiled ` +
			`tree. Recompile, then rebuild: yarn compile && node mailwoman/out/cli.js eval gauntlet-build regression-db`
	)
}
