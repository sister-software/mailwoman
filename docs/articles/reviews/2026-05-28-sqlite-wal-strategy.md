# Who's On First -> SQLite Ingest: WAL + Freeze Design Brief

> **Audience:** A fresh Claude Code / DeepSeek instance picking up this task with no prior context. This is your only briefing. Read it end-to-end before touching code.

---

## 1. What we're building

Upgrade Mailwoman's existing WOF SQLite build path. This is **not a greenfield schema**.

Repo entry points:

- `scripts/build-unified-wof.ts` - current GeoJSON -> SQLite builder.
- `resolver-wof-sqlite/unified-schema.ts` - current schema/index helper. Use or extend this as the source of truth.
- `resolver-wof-sqlite/schema.ts` - downstream Kysely contract for WOF-style tables.
- `resolver-wof-sqlite/fts.ts` and `resolver-wof-sqlite/build-fts-cli.ts` - downstream FTS5/R\*Tree/population index lifecycle.

The pipeline should:

1. Read hundreds of thousands of GeoJSON records from WOF repos or cached downloads.
2. Ingest them into SQLite using **Node's built-in `node:sqlite` module** (`DatabaseSync`).
3. Use Piscina workers where they help, primarily for file I/O + JSON parsing.
4. Preserve WOF-compatible tables (`spr`, `names`, `concordances`, `geojson` if enabled, `ancestors` if enabled) so existing resolver code keeps working.
5. Freeze the resulting `.db` into a clean read-only artifact with no `.db-wal` / `.db-shm` sidecars.

The output is a static asset. Treat it like a search index: expensive to build, immutable once shipped.

---

## 2. Why these choices

### Why `node:sqlite` instead of `better-sqlite3`?

- Zero native deps. No `node-gyp`, no prebuilds, no Electron/Bun headaches downstream.
- Mailwoman already uses `node:sqlite` in resolver code and build scripts.
- Current status: added in Node 22.5.0; unflagged in Node 22.13.0+ but still experimental there; release-candidate status starts in newer Node 25/26 lines. Confirm runtime with `node --version` and expect warnings on some Node versions.
- API is intentionally close to `better-sqlite3`: synchronous `prepare()` / `run()` / `get()` / `all()`, `exec()` for batches. Not identical; see §6.

### Why Piscina?

- Built-in `worker_threads` works, but Piscina handles pool lifecycle, queueing, and `destroy()` semantics.
- Workers are useful for reading and parsing many tiny GeoJSON files.
- SQLite still allows one writer at a time, even in WAL mode. Do not assume Piscina creates parallel writes. Keep write transactions short.

### Why WAL during ingest but not at rest?

- WAL (Write-Ahead Logging) gives better multi-connection behavior than rollback journal during ingest.
- One writer at a time still applies. WAL lets workers wait via `busy_timeout` instead of failing with `SQLITE_BUSY`, and it lets readers proceed during writes.
- At rest we want one `.db` file. Consumers will open it read-only, possibly from read-only filesystems or via mmap. WAL adds no value there and complicates distribution.

---

## 3. The three phases

```
PHASE 1: ENUMERATE / DOWNLOAD
  Network + filesystem I/O
  Pull or reuse WOF GeoJSON repos/bundles
  Cache locally so ingest can rerun without re-downloading

PHASE 2: INGEST
  Main thread:
    create temp ingest DB
    set page_size before schema
    enable WAL
    create WOF-compatible schema
    do not create secondary indexes yet

  Workers:
    read files
    parse JSON
    derive WOF rows
    open SQLite connection
    set per-connection pragmas
    BEGIN IMMEDIATE only after parsing
    batch INSERT/UPSERT parsed rows
    COMMIT / ROLLBACK
    close connection in finally

  Main thread:
    wait for all tasks to settle
    await pool.destroy()
    only then continue

PHASE 3: FREEZE
  Single-threaded, main only
    wal_checkpoint(TRUNCATE)
    verify checkpoint busy = 0
    journal_mode = DELETE
    verify returned mode is delete
    create secondary indexes / FTS / R*Tree / stats
    ANALYZE
    PRAGMA integrity_check
    VACUUM INTO final path
    verify final opens read-only
```

The split between phases matters. Don't interleave them.

- **Don't invent a `geojson`-only schema.** Existing resolver code expects WOF-style tables.
- **Don't create secondary indexes before bulk insert.** Every row insert updates every index. Defer.
- **Don't hold the SQLite writer lock while reading files or parsing JSON.** Parse first, then `BEGIN IMMEDIATE`, then insert.
- **Don't flip `journal_mode = DELETE` while workers might still be open.** It returns `wal` when the switch did not happen.
- **Don't skip final validation.** `integrity_check`, no sidecars, and a read-only open are part of the build.

---

## 4. `DatabaseSync` + pragmas: mental model

`node:sqlite` is a thin wrapper around the SQLite C API. There is **no `db.pragma()` helper** like `better-sqlite3`. Apply pragmas via SQL:

```js
db.exec("PRAGMA journal_mode = WAL")
const r = db.prepare("PRAGMA journal_mode").get() // { journal_mode: "wal" }
```

Some pragmas are persistent on the file (`journal_mode`, `page_size`, `auto_vacuum`). Others are per-connection (`synchronous`, `busy_timeout`, `cache_size`, `temp_store`, `mmap_size`, `foreign_keys`). **Per-connection pragmas must be set on every connection, including every worker.**

### Pragma cheat sheet

| Pragma           | Phase              | Value                 | Why                                                                             |
| ---------------- | ------------------ | --------------------- | ------------------------------------------------------------------------------- |
| `page_size`      | Before first write | `8192`                | Larger pages can help blob-heavy DBs. Must be set before any table exists.      |
| `journal_mode`   | Ingest             | `WAL`                 | Better multi-connection writer hand-off.                                        |
| `journal_mode`   | Freeze             | `DELETE`              | Strip sidecars, restore default.                                                |
| `synchronous`    | Ingest             | `NORMAL`              | Safe from corruption in WAL mode; may lose last commits on OS crash/power loss. |
| `foreign_keys`   | All                | `ON`                  | Default varies by wrapper/version. Be explicit.                                 |
| `busy_timeout`   | Ingest             | `30000`               | Workers wait for writer lock instead of immediate `SQLITE_BUSY`.                |
| `cache_size`     | Ingest             | `-64000` to `-200000` | Negative = KiB. Remember this is per connection, so multiply by worker count.   |
| `temp_store`     | All                | `MEMORY`              | Faster temp tables/index sorts when memory allows.                              |
| `mmap_size`      | Read-only          | `268435456`           | 256 MiB mmap window for reads.                                                  |
| `query_only`     | Read-only          | `ON`                  | Prevent accidental writes in consumers.                                         |
| `wal_checkpoint` | Freeze             | `TRUNCATE`            | Drain WAL and truncate sidecar before switching journal mode.                   |

`synchronous = OFF` is acceptable only if the build DB is disposable and the implementation deletes/restarts it after any interrupted build. It is faster, but unlike `NORMAL` in WAL mode, an OS crash can corrupt the ingest DB.

---

## 5. Code sketch

This is TypeScript-shaped pseudocode. Adapt the existing `scripts/build-unified-wof.ts` implementation rather than copying this into new files.

### Main orchestrator

```ts
import { createUnifiedIndexes, createUnifiedSchema } from "@mailwoman/resolver-wof-sqlite/unified-schema"
import Piscina from "piscina"
import { existsSync, statSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"

const INGEST_PATH = "/tmp/wof-ingest.db"
const FINAL_PATH = "/tmp/wof-frozen.db"

function assertVacuumTargetIsSafe(path: string) {
	if (!existsSync(path)) return
	if (statSync(path).size === 0) return
	throw new Error(`VACUUM INTO target already exists and is non-empty: ${path}`)
}

{
	const db = new DatabaseSync(INGEST_PATH)
	try {
		db.exec(`
			PRAGMA page_size = 8192;
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = NORMAL;
			PRAGMA foreign_keys = ON;
			PRAGMA busy_timeout = 30000;
			PRAGMA temp_store = MEMORY;
		`)

		// Source of truth: existing WOF-compatible schema helper.
		// Extend this helper if the downstream resolver needs more official WOF tables/columns.
		createUnifiedSchema(db)
	} finally {
		db.close()
	}
}

const pool = new Piscina({
	filename: fileURLToPath(new URL("./build-unified-wof-worker.js", import.meta.url)),
	maxThreads: 4,
})

const filePaths = await enumerateDownloadedFiles()
const batches = chunk(filePaths, 500)

const results = await Promise.allSettled(batches.map((paths) => pool.run({ dbPath: INGEST_PATH, paths })))
await pool.destroy()

const failure = results.find((r) => r.status === "rejected")
if (failure?.status === "rejected") throw failure.reason

assertVacuumTargetIsSafe(FINAL_PATH)

{
	const db = new DatabaseSync(INGEST_PATH)
	try {
		const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
			busy: number
			log: number
			checkpointed: number
		}
		if (checkpoint.busy !== 0) {
			throw new Error(`WAL checkpoint did not finish: ${JSON.stringify(checkpoint)}`)
		}

		const mode = db.prepare("PRAGMA journal_mode = DELETE").get() as { journal_mode: string }
		if (mode.journal_mode !== "delete") {
			throw new Error(`journal_mode switch failed; still ${mode.journal_mode}. A connection is still open.`)
		}

		createUnifiedIndexes(db)
		// Build place_search/place_bbox/place_population here if this artifact should ship them.
		// Use resolver-wof-sqlite/fts.ts; do not duplicate its SQL.

		db.exec("ANALYZE")
		db.exec("PRAGMA optimize")

		const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }
		if (integrity.integrity_check !== "ok") {
			throw new Error(`integrity_check failed: ${integrity.integrity_check}`)
		}

		db.prepare("VACUUM INTO ?").run(FINAL_PATH)
	} finally {
		db.close()
	}
}

{
	const db = new DatabaseSync(FINAL_PATH, { readOnly: true })
	try {
		db.exec("PRAGMA query_only = ON")
		const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }
		if (mode.journal_mode !== "delete") throw new Error(`frozen DB journal_mode=${mode.journal_mode}`)
	} finally {
		db.close()
	}
}
```

### Worker task

Key rule: file reads and JSON parsing happen before `BEGIN IMMEDIATE`.

```ts
import { readFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"

export default async function ingestBatch({ dbPath, paths }: { dbPath: string; paths: string[] }) {
	const parsed: Array<{ raw: string; feature: ParsedFeature }> = []

	for (const path of paths) {
		const raw = await readFile(path, "utf8")
		const feature = parseFeature(raw)
		if (feature) parsed.push({ raw, feature })
	}

	if (parsed.length === 0) return { inserted: 0 }

	const db = new DatabaseSync(dbPath)
	let began = false

	try {
		db.exec(`
			PRAGMA synchronous = NORMAL;
			PRAGMA foreign_keys = ON;
			PRAGMA busy_timeout = 30000;
			PRAGMA cache_size = -64000;
			PRAGMA temp_store = MEMORY;
		`)

		const statements = prepareWofInsertStatements(db)

		db.exec("BEGIN IMMEDIATE")
		began = true

		for (const item of parsed) {
			insertWofRows(statements, item.feature, item.raw)
		}

		db.exec("COMMIT")
		began = false
		return { inserted: parsed.length }
	} catch (e) {
		if (began || db.isTransaction) {
			try {
				db.exec("ROLLBACK")
			} catch {
				// Preserve original error.
			}
		}
		throw e
	} finally {
		db.close()
	}
}
```

`prepareWofInsertStatements` / `insertWofRows` should target WOF-compatible tables, not a custom `geojson`-only table. If `geojson` is emitted, use an upstream-compatible shape such as `id INTEGER PRIMARY KEY, body TEXT, source TEXT, is_alt INTEGER, alt_label TEXT, lastmodified INTEGER`, or explicitly model alt geometries in the official `geometries` table. Do **not** use `PRIMARY KEY (id, alt_label) WITHOUT ROWID` while inserting `NULL` `alt_label`; `WITHOUT ROWID` primary-key columns are implicitly `NOT NULL`.

### Consumer side

```ts
import { DatabaseSync } from "node:sqlite"

const db = new DatabaseSync("./wof-frozen.db", { readOnly: true })
db.exec(`
	PRAGMA query_only = ON;
	PRAGMA cache_size = -32000;
	PRAGMA mmap_size = 268435456;
	PRAGMA temp_store = MEMORY;
`)

const row = db.prepare("SELECT name, latitude, longitude FROM spr WHERE id = ?").get(85633041)
```

---

## 6. Critical gotchas

### This is not a new schema

Mailwoman's resolver expects WOF-style tables (`spr`, `names`, `concordances`, and optional `geojson` / `ancestors` / derived FTS/R\*Tree/population tables). The official WOF SQLite distributions use these table names. Mirror them unless there is a documented reason not to.

### `BEGIN IMMEDIATE` after parsing, not before

A plain `BEGIN` starts a deferred transaction. If two workers both try to upgrade to writer, one can get `SQLITE_BUSY` mid-transaction. `BEGIN IMMEDIATE` grabs the writer lock upfront, so other workers wait.

But don't grab that lock while reading files or parsing JSON. The writer lock should cover only SQL writes.

### Wait for all tasks, then destroy the pool

Use `Promise.allSettled(...)`, then `await pool.destroy()`, then rethrow the first failure. `Promise.all(...)` rejects on the first failure while other tasks may still be running. The freeze phase must not start until every worker task has returned and the pool is destroyed.

### `journal_mode` is per-file, not per-connection

Once WAL is set on the file, every connection from every process sees WAL. Set it once on the main thread before spawning workers. Verify the returned value when switching back to `DELETE`.

### `page_size` must be set before any table

If set later, it is ignored unless you `VACUUM`. Set it before `createUnifiedSchema(db)`.

### `synchronous = NORMAL` in WAL mode is the safe default

WAL + `NORMAL` remains consistent and safe from database corruption, but can lose the last committed transactions on OS crash or power loss. That is acceptable for a rebuildable ingest artifact. If you choose `OFF`, document that interrupted builds must be discarded.

### `DatabaseSync` is synchronous

Every query blocks the event loop of whichever thread called it. Fine in workers. On the main thread, keep setup/freeze explicit and bounded.

### One `DatabaseSync` per worker task

Never share a `DatabaseSync` instance across threads. Each worker opens its own connection and closes it in `finally`.

### `VACUUM INTO` target must be absent or empty

`VACUUM INTO ?` fails if the output file already exists and is non-empty. Check this before freeze. Bind the path as a parameter; do not interpolate it into SQL.

### WAL requires a local filesystem

Do not put the ingest DB on NFS, SMB, or another network mount. WAL's shared-memory index needs local filesystem semantics. The frozen output is fine to ship anywhere.

### macOS fsync caveat

If durability across power loss matters on macOS, consider `PRAGMA fullfsync = ON`. For this pipeline, re-ingest is usually cheaper.

---

## 7. Design decisions — resolved 2026-05-28

Reviewed with DeepSeek, grounded in existing codebase behavior and downstream consumer contracts.

### 1. Table contract

**Ship: `spr`, `names`, `concordances`, `place_population`, `ancestors`. `geojson` ephemeral only. No `geometries`.**

`ancestors` is required — the FST builder's parent-chain resolution (`fst-builder.ts:88`) falls back to the ancestors table when `spr.parent_id` is a sentinel (-1, -4). The `geojson` table (raw `body TEXT`) is needed during build for `wof:population` extraction via `json_extract()`, but is dropped before VACUUM — it accounts for ~95% of DB size and is never read at query time. A separate `geometries` table adds no resolver value since bounding boxes and centroids already live in `spr`.

### 2. Body storage

**Yes during build, dropped before freeze.**

The `geojson.body` column is the only way to extract `wof:population` (used by `build-importance.ts` population fallback and `fts.ts::buildPlaceSearchFts` population aux table). After extraction into `place_population`, the table is dropped. The frozen artifact never contains raw GeoJSON text.

### 3. Sharding

**Both — per-country shards as canonical, monolith as convenience.**

The resolver already supports multi-shard ATTACH (`sharding.ts`, `multi-shard.test.ts`). Per-country shards give clean separation, independent update cadences, and smaller downloads. The monolith is a rollup (ATTACH + INSERT SELECT + VACUUM) for consumers that don't want to manage multiple files. Build per-country in parallel, merge on demand.

### 4. Alt geometries

**Skip.**

The existing builder already excludes `-alt-*` GeoJSON files. Alt geometries are alternate polygon representations for the same WOF ID — useful for cartography but irrelevant for address parsing. Including them would add duplicate rows or clobber the primary lat/lon/bbox via INSERT OR REPLACE.

### 5. Resumability

**Manifest-based for GeoJSON ingestion; rebuild-from-scratch for aux tables.**

For ~1M global files, a lightweight manifest (JSONL: `{path, wof_id, mtime, status}`) lets resumed builds skip already-processed files. The manifest maps to the existing spliterator batching pipeline — glob emits candidates, manifest filters completed ones. Aux tables (FTS5, R\*Tree, population) are always rebuilt from scratch since they depend on final `spr` state.

### 6. Worker responsibility

**Workers return parsed data to a single main-thread writer.**

This is the fix for the database lock bug that blocked the current `wof/prepare` command. Workers read files + parse JSON in parallel, return `ParsedFeature` structs to the main thread. The main thread runs INSERTs in batched transactions (~500 rows). WAL mode allows concurrent readers during writes, but concurrent writers still serialize — lean into that constraint. The bottleneck is file I/O, not SQLite writes.

---

## 8. Prior art worth reading before writing code

- **Current builder:** `scripts/build-unified-wof.ts`.
- **Current schema helper:** `resolver-wof-sqlite/unified-schema.ts`.
- **Downstream resolver contract:** `resolver-wof-sqlite/schema.ts`, `resolver-wof-sqlite/lookup.ts`, `resolver-wof-sqlite/fts.ts`.
- **WOF official SQLite bundles:** <https://dist.whosonfirst.org/sqlite/> or <https://www.whosonfirst.org/download/>. Download one and run `.schema` on it.
- **`whosonfirst/go-whosonfirst-sqlite-features`:** <https://github.com/whosonfirst/go-whosonfirst-sqlite-features>. Reference schema/table builders.
- **Node.js `node:sqlite` docs:** <https://nodejs.org/api/sqlite.html>.
- **SQLite WAL docs:** <https://sqlite.org/wal.html>.
- **SQLite PRAGMA reference:** <https://sqlite.org/pragma.html>.
- **SQLite `VACUUM INTO` docs:** <https://sqlite.org/lang_vacuum.html>.
- **Piscina:** <https://github.com/piscinajs/piscina>.

---

## 9. Definition of done

- Existing WOF resolver tests still pass, especially FTS, sharding, population, proximity, and slim-build tests.
- Artifact exposes the expected WOF-compatible tables for the chosen feature set.
- `PRAGMA journal_mode` on the frozen file returns `delete`.
- `PRAGMA integrity_check` returns `ok`.
- No `.db-wal` / `.db-shm` sidecars remain for the frozen file.
- Opening with `new DatabaseSync(path, { readOnly: true })` works.
- `PRAGMA query_only = ON` works for consumers.
- Representative resolver queries return expected rows:
  - ID lookup via `spr.id`.
  - Name lookup via `place_search` if FTS is shipped.
  - Parent/country/placetype filters for current resolver behavior.
- File size is reasonable after `VACUUM INTO`.
- Build failure does not leave worker threads running or connections open.
