/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Decision 6 (2b task 7) layer-absent guards — pulled out of `cli.ts` into their own importable module (task 7
 *   fix round 1 review finding) so the branching itself has direct unit coverage (`layer-guards.test.ts`), not just
 *   "the tool handler passes an abstain through" (`tools.test.ts`'s stub-level dispatch tests). `cli.ts`
 *   top-level-`await`s a real stdio transport connection at import time, so IT can't be imported by vitest — these
 *   three functions have no such dependency (pure existence-check + open, or a thrown Error), so they live here and
 *   `cli.ts` just calls them.
 *
 *   - `openBDCDatabaseIfPresent` / `openPlausibilityPOIDeps` — `mailwoman_plausibility_check`'s `bdcDB`/`poi` deps
 *     (`PlausibilityDeps`) are each OPTIONAL, so a missing/absent path degrades to `undefined`, which
 *     `plausibilityCheck` (`@mailwoman/bdc`) already turns into a typed abstain evidence entry
 *     (`{type:"abstain", reason:"requires_bdc_layer"|"requires_build_local_layer"}`) — never a raw sqlite throw.
 *   - `assertBDCDatabaseExists` — `mailwoman_bdc_filing_landscape` requires bdc.db unconditionally (no optional-dep
 *     abstain shape exists for that tool), so a missing file becomes one friendly thrown `Error` naming the layer
 *     instead of the raw `node:sqlite` "unable to open database file" message.
 *   - `openFilerDatabaseIfPresent` / `assertFilerDatabaseExists` (3a task 7) — the SAME pairing, for filer.db.
 *     `mailwoman_filer_lookup` requires filer.db unconditionally (mirrors `mailwoman_bdc_filing_landscape`'s own
 *     "requires the layer" discipline — `filerLookup` itself has no optional-dep abstain shape either, since gate
 *     4 makes it throw rather than answer unstamped), so `cli.ts` pairs `assertFilerDatabaseExists` (the friendly
 *     throw) with `openFilerDatabaseIfPresent` (the actual open) the same way `bdcFilingLandscape`'s handler does.
 */

import { existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import type { BDCDatabase, PlausibilityDeps } from "@mailwoman/bdc"
import { DatabaseClient } from "@mailwoman/core/kysley/client"
import type { LayerContractDatabase } from "@mailwoman/core/layers"
import type { FilerDatabase } from "@mailwoman/filer"

/**
 * Open a bdc.db, or return `undefined` when `databasePath` is unset or the file is missing — NEVER a raw sqlite throw.
 * See the module header.
 */
export function openBDCDatabaseIfPresent(databasePath: string | undefined): DatabaseClient<BDCDatabase> | undefined {
	if (!databasePath || !existsSync(databasePath)) return undefined

	return new DatabaseClient<BDCDatabase>({ database: new DatabaseSync(databasePath, { readOnly: true }) })
}

/**
 * Same graceful discipline as {@link openBDCDatabaseIfPresent}, for the poi.db side of `plausibilityCheck`'s deps —
 * `undefined` here becomes the `{type:"abstain", reason:"requires_build_local_layer"}` entry `plausibilityCheck`
 * already produces when a claimed technology's physical-plant categories can't be searched. `POILookup` is dynamically
 * imported (matching `cli.ts`'s existing `resolver-wof-sqlite` laziness) since it's only ever needed when a caller
 * actually wires a poi.db. `lookup` and `contractDB` share ONE `DatabaseSync` handle (the AGENTS.md "one connection,
 * shared" convention) — a real poi.db's rows and its `layer_manifest`/`layer_coverage` tables live in the same file in
 * production, so disposing `contractDB` (which closes the shared handle) is enough; `POILookup` never owns it
 * (constructed with `{database}`, not `{databasePath}` — see `poi-lookup.ts`), so it never double-closes.
 */
export async function openPlausibilityPOIDeps(databasePath: string | undefined): Promise<PlausibilityDeps["poi"]> {
	if (!databasePath || !existsSync(databasePath)) return undefined

	const { POILookup } = await import("@mailwoman/resolver-wof-sqlite/poi-lookup")
	const database = new DatabaseSync(databasePath, { readOnly: true })

	return {
		lookup: new POILookup({ database }),
		contractDB: new DatabaseClient<LayerContractDatabase>({ database }),
	}
}

/**
 * Throws a friendly Error naming the layer when `databasePath` doesn't exist — `mailwoman_bdc_filing_landscape`'s guard
 * (decision 6b). `toolName` is threaded through so the message matches whichever tool calls this (today: only
 * `mailwoman_bdc_filing_landscape`).
 */
export function assertBDCDatabaseExists(toolName: string, databasePath: string): void {
	if (!existsSync(databasePath)) {
		throw new Error(`${toolName}: bdc.db not found at "${databasePath}"`)
	}
}

/**
 * Open a filer.db, or return `undefined` when `databasePath` is unset or the file is missing — NEVER a raw sqlite throw
 * (3a task 7, mirroring {@link openBDCDatabaseIfPresent}). Used by `cli.ts`'s `mailwoman_filer_lookup` handler after
 * {@link assertFilerDatabaseExists} has already confirmed the file is present.
 */
export function openFilerDatabaseIfPresent(
	databasePath: string | undefined
): DatabaseClient<FilerDatabase> | undefined {
	if (!databasePath || !existsSync(databasePath)) return undefined

	return new DatabaseClient<FilerDatabase>({ database: new DatabaseSync(databasePath, { readOnly: true }) })
}

/**
 * Throws a friendly Error naming the layer when `databasePath` doesn't exist — `mailwoman_filer_lookup`'s guard (3a
 * task 7, mirroring {@link assertBDCDatabaseExists}). `filerLookup` itself has no optional-dep abstain shape (gate 4
 * makes it throw rather than answer unstamped), so filer.db is required unconditionally, same as bdc.db is for
 * `mailwoman_bdc_filing_landscape`.
 */
export function assertFilerDatabaseExists(toolName: string, databasePath: string): void {
	if (!existsSync(databasePath)) {
		throw new Error(`${toolName}: filer.db not found at "${databasePath}"`)
	}
}
