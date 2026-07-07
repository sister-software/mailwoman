/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The admin build's Freeze phase, extracted from `scripts/build-unified-wof.ts`: WAL checkpoint →
 *   journal freeze → ancestors closure → `ancestors(id)` index (BEFORE the −4 backfill — without it
 *   the backfill's per-candidate lookups full-scan the 13M-row table each time and the build stalls
 *   for hours, #1015) → `wof:hierarchy` −4 backfill (WOF ids only) → coincident_roles → indexes →
 *   ANALYZE → integrity check. Runs IN PLACE on the staging DB; the caller `VACUUM INTO`s the final
 *   artifact afterwards.
 */

import type { DatabaseSync } from "node:sqlite"

import { OVERTURE_ID_BASE } from "./fold-overture.js"

export interface FreezeAdminOptions {
	/**
	 * Repos root for the `wof:hierarchy` −4 backfill (#440/#832 — NYC/London-class multi-parent orphans). Omit ONLY in
	 * fixture tests; a real build without it leaves those metros unreachable by the region-descendant filter.
	 */
	dataDir?: string
	onPhase?: (phase: string, detail?: string) => void
}

export interface FreezeAdminResult {
	ancestorRows: number
	backfillPlacesFixed: number
	coincidentRoles: number
}

/** Freeze an ingested admin staging DB (see the module docstring for the exact order and why it matters). */
export async function freezeAdmin(db: DatabaseSync, opts: FreezeAdminOptions = {}): Promise<FreezeAdminResult> {
	// resolver-wof-sqlite is an OPTIONAL peer of mailwoman — import it lazily (the gazetteer-pipeline
	// convention) so eagerly loading this module (pastel imports every command) never faults without it.
	const { backfillAncestorsFromHierarchy, discoverAdminDataRoots } =
		await import("@mailwoman/resolver-wof-sqlite/ancestry-backfill")
	const { buildCoincidentRoles } = await import("@mailwoman/resolver-wof-sqlite/coincident-roles")
	const { createUnifiedIndexes, populateAncestors } = await import("@mailwoman/resolver-wof-sqlite/unified-schema")
	const phase = opts.onPhase ?? (() => {})

	// An in-memory fixture has no WAL to checkpoint (journal_mode reports `memory`); skip the freeze pragmas there.
	const journal = (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode

	if (journal !== "memory") {
		phase("checkpoint")
		const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number }

		if (checkpoint.busy !== 0) {
			throw new Error(`freezeAdmin: WAL checkpoint did not finish: ${JSON.stringify(checkpoint)}`)
		}

		phase("journal", "delete")
		const mode = db.prepare("PRAGMA journal_mode = DELETE").get() as { journal_mode: string }

		if (mode.journal_mode !== "delete") {
			throw new Error(`freezeAdmin: journal_mode switch failed; still ${mode.journal_mode}`)
		}
	}

	phase("ancestors", "parent_id closure")
	const ancestorRows = populateAncestors(db)

	// Index `ancestors(id)` NOW — before the −4 backfill probes it. `createUnifiedIndexes` (below) builds this same
	// index, but it runs AFTER the backfill; without it here the backfill's per-candidate lookups full-scan the
	// closure table EACH time (#1015). `IF NOT EXISTS` keeps the later createUnifiedIndexes a no-op.
	phase("ancestors-index")
	db.exec("CREATE INDEX IF NOT EXISTS ancestors_by_id ON ancestors(id)")

	let backfillPlacesFixed = 0

	if (opts.dataDir) {
		phase("hierarchy-backfill", "multi-parent -4 places")
		const geojsonRoots = discoverAdminDataRoots(opts.dataDir)

		if (geojsonRoots.length === 0) {
			phase(
				"hierarchy-backfill",
				`WARNING: no */data geojson roots under ${opts.dataDir} — orphans like NYC stay unreachable`
			)
		} else {
			// Only real WOF places have `wof:hierarchy` geojson; synthetic Overture/GeoNames rows (ids >=
			// OVERTURE_ID_BASE) never do, and probing millions of them across every repo root turned this step into a
			// ~40-min stall on the wide-coverage build (#1015). Their ancestry comes from the parent_id closure.
			const bf = backfillAncestorsFromHierarchy(db, geojsonRoots, { maxId: OVERTURE_ID_BASE })
			backfillPlacesFixed = bf.placesFixed
			phase("hierarchy-backfill", `+${bf.rowsAdded} rows for ${bf.placesFixed} places (${bf.noGeojson} no-geojson)`)
		}
	}

	// Dual-role-place relation (#403, epic #402) — needs `ancestors` + `spr` bbox + `place_population`,
	// all present by now. Drives the resolver's hierarchy completion (on by default).
	phase("coincident-roles")
	const roles = buildCoincidentRoles(db)

	phase("indexes")
	await createUnifiedIndexes(db)

	phase("analyze")
	db.exec("ANALYZE")
	db.exec("PRAGMA optimize")

	phase("integrity")
	const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }

	if (integrity.integrity_check !== "ok") {
		throw new Error(`freezeAdmin: integrity_check failed: ${integrity.integrity_check}`)
	}

	return { ancestorRows, backfillPlacesFixed, coincidentRoles: roles.rowCount }
}
