/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Apply the worker's D1 migrations to the test database. The pool reads `migrations/*.sql` on the Node side
 *   (`readD1Migrations` in vitest.config.ts) and hands them in as the `TEST_MIGRATIONS` binding; `applyD1Migrations`
 *   runs the ones not yet recorded. Each test file gets a fresh D1, so a `beforeAll` per file is enough.
 */

import { applyD1Migrations, type D1Migration, env } from "cloudflare:test"

export async function applyMigrations(db: D1Database): Promise<void> {
	await applyD1Migrations(db, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS)
}
