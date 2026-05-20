/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared `Database` typing for the Kysely client at `core/kysley/client.ts`.
 *
 *   This file intentionally ships an empty schema. Consumers that want compile-time table typing
 *   should extend `Kysely<TheirSchema>` directly rather than baking a schema into core — the WOF
 *   resolver (Phase 4.2), corpus adapters, and any future consumer all touch different tables.
 *
 *   The exported `Database` interface exists so `client.ts` has a target for `Kysely<Database>` and
 *   the boilerplate compiles without forcing a concrete schema commitment.
 */

/**
 * Empty schema marker. Consumers declare their own schema interface and pass it directly to `new
 * Kysely<MySchema>({...})` or instantiate `new DatabaseClient<MySchema>(...)` once `DatabaseClient`
 * becomes generic (Phase 4.2 work).
 */
export type Database = Record<string, never>
