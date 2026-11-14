// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The WOF record store: every GeoJSON record under a WOF data root, reduced to the
 *   properties its readers use and kept in one SQLite database clustered on WOF id.
 *
 *   The admin gazetteer ingest and the corpus `wof-admin` and `wof-postalcode` adapters read the store
 *   in place of the GeoJSON tree. The tree is 121 GB, almost all of it geometry, and none of those
 *   readers consults geometry. Each reader parses a stored feature with its own parser, unchanged, so the
 *   store keeps every rule the readers apply.
 *
 *   The store is a cache rather than a published artifact. A refresh rewrites one repository's rows
 *   in a transaction when that repository's key changes, and leaves the other repositories' rows.
 */

import { cacheRootPath } from "@mailwoman/core/data-root"
import { readLocalTextFile, sortedGlob } from "@mailwoman/core/fs/readers"
import { pathExists, statLink } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { git, gitHead } from "@mailwoman/core/git"
import { sha256File, sha256Hex } from "@mailwoman/core/hash"
import { parseJSONStrict, stringifyJSON, tryParsingJSON } from "@mailwoman/core/json"
import { compareByScalarValue } from "@mailwoman/core/strings/compare"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { Kysely } from "kysely"
import { basename, dirname, PathBuilder, type PathBuilderLike, resolvePath } from "path-ts"
import { AsyncSequence } from "spliterator"
import { Globerator } from "spliterator/node/fs"

/**
 * One stored record.
 */
export interface WOFRecordTable {
	/**
	 * The record's `wof:id`, which clusters the table.
	 */
	id: number
	/**
	 * The repository directory's name, `whosonfirst-data-admin-us`.
	 */
	repo: string
	/**
	 * The GeoJSON file's path relative to the repository.
	 */
	path: string
	/**
	 * `wof:country` upper-cased, or `''` when the record states none, so a one-country read uses the index.
	 */
	country: string
	/**
	 * `wof:placetype`, or `''` when the record states none.
	 */
	placetype: string
	/**
	 * `{"type", "id", "properties"}` with the properties {@linkcode isStoredProperty} keeps, in source order.
	 */
	feature: string
}

/**
 * The key a repository's rows were stored under.
 */
export interface WOFRepoStateTable {
	repo: string
	key: string
	records: number
	/**
	 * Files that were unreadable, weren't JSON, or had no numeric `wof:id`.
	 */
	skipped: number
}

/**
 * The record store's schema, for `new DatabaseClient<WOFRecordStoreDatabase>(...)`.
 */
export interface WOFRecordStoreDatabase {
	wof_record: WOFRecordTable
	wof_repo_state: WOFRepoStateTable
}

/**
 * The store's format.
 *
 * A change to the stored columns, the stored properties or the reduction takes a new number.
 * The new number gives the store a new file and every repository a new key.
 */
const RECORD_STORE_FORMAT = 2

/**
 * Creates the store's tables when absent.
 *
 * `wof_record` keys on `id` as SQLite's rowid, so a scan in id order reads the table in storage order.
 * The `(repo, path)` index serves a repository's delete.
 *
 * The `(country, id)` index serves a one-country read in id order.
 */
export async function createWOFRecordStoreTables(db: Kysely<WOFRecordStoreDatabase>): Promise<void> {
	await db.schema
		.createTable("wof_record")
		.ifNotExists()
		.addColumn("id", "integer", (col) => col.primaryKey())
		.addColumn("repo", "text", (col) => col.notNull())
		.addColumn("path", "text", (col) => col.notNull())
		.addColumn("country", "text", (col) => col.notNull())
		.addColumn("placetype", "text", (col) => col.notNull())
		.addColumn("feature", "text", (col) => col.notNull())
		.execute()

	await db.schema.createIndex("wof_record_by_repo").ifNotExists().on("wof_record").columns(["repo", "path"]).execute()

	await db.schema
		.createIndex("wof_record_by_country")
		.ifNotExists()
		.on("wof_record")
		.columns(["country", "id"])
		.execute()

	await db.schema
		.createTable("wof_repo_state")
		.ifNotExists()
		.addColumn("repo", "text", (col) => col.primaryKey())
		.addColumn("key", "text", (col) => col.notNull())
		.addColumn("records", "integer", (col) => col.notNull())
		.addColumn("skipped", "integer", (col) => col.notNull())
		.execute()
}

/**
 * The record store for a WOF data root: `<cache-root>/derived/wof-records/<name>-<hash>.db`.
 *
 * `<name>` is the data root's directory name and `<hash>` the first 12 hex digits of the
 * sha256 of its resolved path, so two data roots with one name keep separate stores.
 * The store stays out of the data root, because the data root may be a committed fixture directory.
 */
export function wofRecordStorePathFor(dataDir: PathBuilderLike): string {
	const resolved = resolvePath(dataDir.toString())

	return cacheRootPath(
		"derived",
		"wof-records",
		`${basename(resolved)}-${sha256Hex(resolved).slice(0, 12)}-v${RECORD_STORE_FORMAT}.db`
	)
}

/**
 * The properties outside the `wof:` and `name:` families that a reader of the store uses.
 */
const STORED_PROPERTIES: ReadonlySet<string> = new Set([
	"mz:is_current",
	"geom:latitude",
	"geom:longitude",
	"geom:bbox",
	"lbl:latitude",
	"lbl:longitude",
	"gn:population",
	"edtf:deprecated",
	"edtf:cessation",
])

/**
 * Whether the store keeps a property: every `wof:` and `name:` property, and {@linkcode STORED_PROPERTIES}.
 *
 * A reader that starts using another property needs it added here.
 * The list is part of every repository's key, so each repository is reduced again on the next refresh.
 */
export function isStoredProperty(key: string): boolean {
	return key.startsWith("wof:") || key.startsWith("name:") || STORED_PROPERTIES.has(key)
}

/**
 * A WOF GeoJSON feature as the store keeps it.
 */
export interface StoredWOFFeature {
	type?: unknown
	id?: unknown
	properties?: Record<string, unknown>
}

/**
 * The stored form of one GeoJSON file's text and its WOF id, or `null` when the text
 * isn't a JSON object with properties holding a numeric `wof:id`.
 */
export function reduceWOFFeature(
	text: string
): { id: number; country: string; placetype: string; feature: string } | null {
	const parsed = tryParsingJSON<{ type?: unknown; id?: unknown; properties?: unknown }>(text)

	if (!parsed || typeof parsed !== "object" || !parsed.properties || typeof parsed.properties !== "object") return null
	const source = parsed.properties as Record<string, unknown>
	const rawID = source["wof:id"]
	const id = typeof rawID === "number" ? rawID : typeof rawID === "string" ? Number(rawID) : Number.NaN

	if (!Number.isSafeInteger(id)) return null
	const properties: Record<string, unknown> = {}

	for (const [key, value] of Object.entries(source)) {
		if (isStoredProperty(key)) {
			properties[key] = value
		}
	}

	const reduced: StoredWOFFeature = { type: parsed.type, id: parsed.id, properties }
	const country = source["wof:country"]
	const placetype = source["wof:placetype"]

	return {
		id,
		country: typeof country === "string" ? country.toUpperCase() : "",
		placetype: typeof placetype === "string" ? placetype : "",
		feature: stringifyJSON(reduced),
	}
}

/**
 * The key for a repository's rows: its head commit, its `git status --porcelain` listing,
 * the sha256 of each changed file, the store format and the stored-property list.
 *
 * Returns `null` for a directory that isn't a git checkout.
 * The refresh reduces such a directory every time.
 */
export async function wofRepoKey(repoDir: PathBuilderLike): Promise<string | null> {
	const repo = PathBuilder.from(repoDir)

	if (!(await pathExists(repo(".git")))) return null

	const lines = [
		`head ${await gitHead(repo)}`,
		`format ${RECORD_STORE_FORMAT}`,
		`properties wof:* name:* ${[...STORED_PROPERTIES].toSorted().join(" ")}`,
	]

	const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], repo)

	for (const entry of status.split("\0").filter(Boolean).toSorted(compareByScalarValue)) {
		const path = entry.slice(3)
		const file = repo(path)

		lines.push(`${entry} ${(await pathExists(file)) ? await sha256File(file) : "absent"}`)
	}

	return `sha256:${sha256Hex(lines.join("\n"))}`
}

/**
 * The repositories under a WOF data root, in name order: each git checkout or directory
 * holding `data/` directly under it, or the root itself when it is one repository.
 */
export async function wofRepositories(dataDir: PathBuilderLike): Promise<PathBuilder[]> {
	const root = PathBuilder.from(dataDir)

	if (await pathExists(root("data"))) return [root]
	const repos: PathBuilder[] = []

	for (const entry of await sortedGlob(root, "*", { onlyFiles: false })) {
		const repo = PathBuilder.from(entry)

		// Only a directory can be a checkout.
		// A link to one would reduce that checkout a second time under another name.
		if (!(await statLink(repo)).isDirectory()) continue

		if ((await pathExists(repo("data"))) || (await pathExists(repo(".git")))) {
			repos.push(repo)
		}
	}

	return repos
}

/**
 * What one refresh did for one repository.
 */
export interface WOFRepoRefresh {
	repo: string
	/**
	 * `reused` when the stored key matched, `reduced` when the rows were rewritten.
	 */
	action: "reused" | "reduced"
	records: number
	skipped: number
}

/**
 * Brings the store at `storePath` up to date with every repository under `dataDir`, creating it when absent.
 *
 * A repository whose key matches its stored key keeps its rows.
 * Any other repository has its rows deleted and its GeoJSON files reduced again,
 * in one transaction, in path order.
 *
 * A stored repository no longer under `dataDir` loses its rows.
 *
 * Two files holding one `wof:id` throw, naming both paths, because the readers key records by id.
 */
export async function refreshWOFRecordStore(
	storePath: PathBuilderLike,
	dataDir: PathBuilderLike,
	opts: { signal?: AbortSignal; onRepo?: (refresh: WOFRepoRefresh) => void } = {}
): Promise<WOFRepoRefresh[]> {
	await makeDirectories(dirname(storePath.toString()))
	using db = new DatabaseClient<WOFRecordStoreDatabase>(storePath)

	db.exec("PRAGMA journal_mode = WAL")
	db.exec("PRAGMA synchronous = NORMAL")
	await createWOFRecordStoreTables(db)

	const stored = new Map(
		(db.prepare("SELECT repo, key FROM wof_repo_state").all() as Array<{ repo: string; key: string }>).map((row) => [
			row.repo,
			row.key,
		])
	)

	const repos = await wofRepositories(dataDir)
	const present = new Set(repos.map((repo) => repo.basename()))
	const results: WOFRepoRefresh[] = []

	for (const repo of stored.keys()) {
		if (!present.has(repo)) {
			deleteRepo(db, repo)
		}
	}

	for (const repoDir of repos) {
		opts.signal?.throwIfAborted()
		const repo = repoDir.basename()
		const key = await wofRepoKey(repoDir)
		let result: WOFRepoRefresh

		if (key && stored.get(repo) === key) {
			const state = db.prepare("SELECT records, skipped FROM wof_repo_state WHERE repo = ?").get(repo) as {
				records: number
				skipped: number
			}

			result = { repo, action: "reused", records: state.records, skipped: state.skipped }
		} else {
			result = await reduceRepo(db, repoDir, repo, key ?? "unversioned", opts.signal)
		}

		results.push(result)
		opts.onRepo?.(result)
	}

	return results
}

function deleteRepo(db: DatabaseClient<WOFRecordStoreDatabase>, repo: string): void {
	db.exec("BEGIN")
	db.prepare("DELETE FROM wof_record WHERE repo = ?").run(repo)
	db.prepare("DELETE FROM wof_repo_state WHERE repo = ?").run(repo)
	db.exec("COMMIT")
}

async function reduceRepo(
	db: DatabaseClient<WOFRecordStoreDatabase>,
	repoDir: PathBuilder,
	repo: string,
	key: string,
	signal: AbortSignal | undefined
): Promise<WOFRepoRefresh> {
	const listed: string[] = await Globerator.from("**/*.geojson", {
		cwd: repoDir,
		absolute: false,
		exclude: ["**/*-alt-*.geojson"],
		followSymlinks: true,
		signal,
	}).toArray()

	const reduced = AsyncSequence.from<string>(listed.toSorted(compareByScalarValue)).parallelMap(
		async (path) => {
			try {
				return { path, record: reduceWOFFeature(await readLocalTextFile(repoDir(path))) }
			} catch {
				return { path, record: null }
			}
		},
		{ ordered: true, signal }
	)

	const insert = db.prepare(
		"INSERT INTO wof_record (id, repo, path, country, placetype, feature) VALUES (?, ?, ?, ?, ?, ?)"
	)

	const holder = db.prepare("SELECT repo, path FROM wof_record WHERE id = ?")
	let records = 0
	let skipped = 0

	db.exec("BEGIN")

	try {
		db.prepare("DELETE FROM wof_record WHERE repo = ?").run(repo)

		for await (const { path, record } of reduced) {
			if (!record) {
				skipped++

				continue
			}

			try {
				insert.run(record.id, repo, path, record.country, record.placetype, record.feature)
			} catch (error) {
				const existing = holder.get(record.id) as { repo: string; path: string } | undefined

				if (!existing) throw error

				throw new Error(
					`refreshWOFRecordStore: wof:id ${record.id} is in ${existing.repo}/${existing.path} and ${repo}/${path}`,
					{ cause: error }
				)
			}

			records++
		}

		db.prepare("INSERT OR REPLACE INTO wof_repo_state (repo, key, records, skipped) VALUES (?, ?, ?, ?)").run(
			repo,
			key,
			records,
			skipped
		)

		db.exec("COMMIT")
	} catch (error) {
		db.exec("ROLLBACK")

		throw error
	}

	return { repo, action: "reduced", records, skipped }
}

/**
 * One stored record as a reader receives it, with its feature parsed as the type the reader names.
 *
 * The parse checks no shape, as a reader of the GeoJSON file didn't.
 */
export interface WOFStoredRecord<F = StoredWOFFeature> {
	id: number
	repo: string
	path: string
	feature: F
}

/**
 * Which stored records a read returns.
 *
 * Each given filter narrows it, and SQLite applies all of them before a feature is parsed.
 */
export interface StoredWOFRecordFilter {
	repos?: readonly string[]
	/**
	 * An upper-case ISO 3166-1 alpha-2 code, read through the `(country, id)` index.
	 */
	country?: string
	placetypes?: ReadonlySet<string>
}

/**
 * Every stored record that `filter` admits, in id order.
 *
 * Each row's feature is parsed as it is yielded, so memory holds one row at a time.
 */
export function* storedWOFRecords<F = StoredWOFFeature>(
	db: DatabaseClient<WOFRecordStoreDatabase>,
	filter: StoredWOFRecordFilter = {}
): Generator<WOFStoredRecord<F>> {
	const clauses: string[] = []
	const params: string[] = []

	const within = (column: string, values: readonly string[]) => {
		clauses.push(`${column} IN (${values.map(() => "?").join(", ")})`)
		params.push(...values)
	}

	if (filter.repos) {
		within("repo", filter.repos)
	}

	if (filter.country) {
		within("country", [filter.country])
	}

	if (filter.placetypes) {
		within("placetype", [...filter.placetypes])
	}

	const statement = db.prepare(
		`SELECT id, repo, path, feature FROM wof_record ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY id`
	)

	for (const row of statement.iterate(...params) as Iterable<{
		id: number
		repo: string
		path: string
		feature: string
	}>) {
		yield { id: row.id, repo: row.repo, path: row.path, feature: parseJSONStrict<F>(row.feature) }
	}
}

/**
 * The stored record with `id`, or `null`.
 */
export function storedWOFRecord<F = StoredWOFFeature>(
	db: DatabaseClient<WOFRecordStoreDatabase>,
	id: number
): WOFStoredRecord<F> | null {
	const row = db.prepare("SELECT id, repo, path, feature FROM wof_record WHERE id = ?").get(id) as
		| { id: number; repo: string; path: string; feature: string }
		| undefined

	return row ? { id: row.id, repo: row.repo, path: row.path, feature: parseJSONStrict<F>(row.feature) } : null
}
