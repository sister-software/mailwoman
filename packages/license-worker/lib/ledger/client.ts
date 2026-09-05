/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Kysely over D1. One handle per request; D1 has no connection to pool or close.
 */

import { Kysely } from "kysely"
import { D1Dialect } from "kysely-d1"

import type { LedgerDatabase } from "#ledger/schema"

export type Ledger = Kysely<LedgerDatabase>

export function openLedger(db: D1Database): Ledger {
	return new Kysely<LedgerDatabase>({ dialect: new D1Dialect({ database: db }) })
}
