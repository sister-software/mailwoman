# @mailwoman/sqlite

This package provides typed Kysely connections backed by Node.js SQLite and helpers for building and opening read-only database artifacts.

Public library. Install with `npm install @mailwoman/sqlite`.

## Quick start

```ts
import { DatabaseClient } from "@mailwoman/sqlite/client"

interface ExampleDatabase {
	places: { id: number; name: string }
}

using db = DatabaseClient.temp<ExampleDatabase>()

await db.schema
	.createTable("places")
	.addColumn("id", "integer", (column) => column.primaryKey())
	.addColumn("name", "text", (column) => column.notNull())
	.execute()

await db.insertInto("places").values({ id: 1, name: "Paris" }).execute()
const place = await db.selectFrom("places").selectAll().where("id", "=", 1).executeTakeFirst()

console.log(place?.name) // "Paris"
```

`DatabaseClient` extends Kysely and owns one SQLite connection. Pass a file path
to its constructor for a persistent database. `DatabaseClient.temp()` creates an
in-memory database. The package requires Node.js `^24.22.1 || >=26.12.1`.

## Open a built artifact

Given an existing database with the example schema:

```ts
import { openBuiltClient } from "@mailwoman/sqlite/sealed"

using db = await openBuiltClient<ExampleDatabase>("/data/places.db")
const places = await db.selectFrom("places").selectAll().execute()
```

`openBuiltClient` opens read-only by default. Its `{ write: true }` option checks
the file's write permissions before opening it and rejects a sealed file with
`SealedArtifactError`. A read-only open does not require that the file has
already been sealed.

Use `using` even when the factory is asynchronous. The connection's
`Symbol.dispose` closes synchronously. The inherited `destroy()` method is
available when explicit asynchronous teardown is needed.

## Build and replace databases

`buildSealedArtifact()`, exported from `@mailwoman/sqlite/sealed/build`, runs
these stages:

1. Create tables and ingest rows into a temporary file beside the destination.
2. Run an optional batched ingest if the initial ingest returns `null`.
3. Run the caller's `finish` callback for checks, indexes and metadata.
4. Vacuum and close the database.
5. Seal the temporary database and swap it into the destination.

`sealDatabase()` checkpoints the write-ahead log, switches journal mode and sets
the file permissions to `0444`. Close writers before sealing.
Keep verification in the build's `finish` callback so it completes before the
replacement becomes visible.

## Query interfaces

Use Kysely's query and schema builders for typed queries and table definitions.
`exec()` supports operations such as pragmas, vacuuming and virtual-table
creation. `prepare()` exposes synchronous prepared statements on the same
connection for bulk inserts and synchronous lookup interfaces.
`function()` registers a SQLite function before statements that call it are
prepared.

Additional subpaths provide batching, schema inspection, column helpers and the
`SQLiteLookup` base class. See [the exports](lib/index.ts) and
[database conventions](AGENTS.md) before adding a builder.

## License

The package declares `AGPL-3.0-only OR LicenseRef-Commercial`.
