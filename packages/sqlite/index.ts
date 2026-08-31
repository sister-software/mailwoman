/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The one way a Mailwoman SQLite connection comes into being.
 *
 *   `DatabaseClient` opens the file; `openBuiltClient` opens a built artifact with the seal check. A caller says which
 *   file and which schema and never constructs the connection, so one database carries one schema, one owner, and a
 *   lifetime `using` can end. `new DatabaseSync` appears once in this package and nowhere else in the repository.
 *
 *   It lives outside `@mailwoman/core` because it needs none of core's 11 MB of parser reference data — its whole
 *   dependency set is `kysely`. That is what lets the leaf lookups use it.
 */

export * from "#client"
export * from "#database-schema"
export * from "#dialect"
export * from "#dialect-config"
export * from "#sealed"
export * from "#sealed-db"
