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
 *
 *   IT IS THE DEFAULT, NOT THE ONLY OPTION, and reading it as the only option is how `as never` gets written. Every
 *   table name typed against `Record<string, never>` IS `never`, so `insertInto("poi")` cannot compile and a caller
 *   who believes no alternative exists casts — which disarms not just that one check but every type-level guarantee
 *   anyone later adds to the table (#1757 has the worked case: a branded key column whose check a neighbouring
 *   `as never` had already defeated).
 */

/**
 * Empty schema marker, and the DEFAULT type argument only.
 *
 * Consumers declare their own schema interface and pass it directly: `new Kysely<MySchema>({…})` or `new
 * DatabaseClient<MySchema>(…)`. `DatabaseClient<DB = Database>` is generic today, so this is available now — the
 * sentence here once deferred it to "Phase 4.2 work", which had already landed, and a reader who believed that had no
 * option but to cast.
 */
export type Database = Record<string, never>
