// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Builds the two gazetteer overlay tile sets from their sources in one run: `wof`,
 *   the Who's On First clones, and `gazetteer`, the places of the admin database.
 *
 *   The run fetches what its work directory lacks, so it starts from an empty disk:
 *
 *   1. It brings each admin repository current as the lab's `gazetteer inspect sync` does,
 *      through `syncWOFRepo` with a read-only origin.
 *      A repos cache in S3 keeps each clone's `.git` between runs.
 *   2. It copies the admin database from an `s3://` URL with the `aws` program.
 *   3. It exports both row sets to GeoParquet.
 *      The gazetteer export reads Overture from Overture's bucket.
 *   4. It builds one PMTiles archive per row set with the `hrt` program.
 *   5. It publishes each archive under the tile worker's keys.
 *
 *   The `overlay-tiles` container image runs this as its entry point.
 */

import { APIClient } from "@mailwoman/core/api"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories, removePath } from "@mailwoman/core/fs/writers"
import { GitClient } from "@mailwoman/core/repo/git"
import { CommandError } from "@mailwoman/core/scripting/command"
import { runProcess } from "@mailwoman/core/scripting/process"
import { parseJSONStrict } from "@mailwoman/core/values/json"
import { FORK_ORG } from "@mailwoman/gazetteer/tools/pipeline/wof/repo-origin"
import { wofRepoName } from "@mailwoman/gazetteer/whosonfirst/extract-repo"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { parallelMap } from "spliterator"

import { OVERLAY_ROW_SETS, type OverlayRowSet } from "#tools/tiles/overlay-row-sets"
import { publishTiles } from "#tools/tiles/publish"

export interface BuildOverlayTilesOptions {
	/**
	 * The directory the run keeps its clones, database, exports and archives under.
	 */
	work: PathBuilderLike
	/**
	 * The tile set version, the suffix of each published name: `v1` publishes `wof.v1` and `gazetteer.v1`.
	 */
	version: string
	/**
	 * The row sets to build and publish, in {@linkcode OVERLAY_ROW_SETS} order.
	 *
	 * @defaultValue every row set
	 */
	rowSets?: readonly OverlayRowSet[]
	/**
	 * The admin database: a local path, or an `s3://` URL the run copies into the work directory.
	 *
	 * The `gazetteer` row set reads it, and a run without that row set needs none.
	 */
	admin?: string
	/**
	 * Lower-case country codes to build, or every country when absent.
	 */
	countries?: readonly string[]
	/**
	 * Reads each country's `postalcode` repository as well as its `admin` repository,
	 * and writes the postcodes to the `wof-postcodes` tile set.
	 */
	postcodes?: boolean
	/**
	 * A directory of existing clones, read as they stand.
	 *
	 * On the lab this is the repos root `gazetteer inspect sync` keeps current.
	 * When absent, the run keeps its own root under the work directory and syncs it read-only.
	 */
	reposDir?: PathBuilderLike
	/**
	 * An `s3://` prefix that holds the run's repos root between runs, one `.git` archive per repository.
	 *
	 * Used only when `reposDir` is absent.
	 */
	reposCache?: string
	/**
	 * An `s3://` prefix that receives a copy of both exports, for a later run or another reader.
	 */
	exportCopy?: string
	/**
	 * The highest zoom each archive is built to.
	 *
	 * @defaultValue the `hrt overlay` default
	 */
	maxZoom?: number
	/**
	 * The `hrt` program.
	 *
	 * @defaultValue `hrt` on the path
	 */
	hrt?: string
	/**
	 * The R2 bucket and key prefix the tile worker reads.
	 */
	bucket: string
	prefix: string
	/**
	 * Builds everything and prints each publish target without uploading.
	 */
	dryRun: boolean
	onPhase?: (phase: string, detail?: string) => void
}

/**
 * Clones run at once.
 *
 * The transfers are bounded by bandwidth and by GitHub, so the count is fixed.
 */
const CLONE_CONCURRENCY = 8

/**
 * The repositories of an organization as GitHub lists them, 100 to a page.
 */
const GITHUB_PAGE_SIZE = 100

/**
 * The most pages a listing reads.
 * The fork organization held 271 repositories on 2026-11-22.
 */
const GITHUB_PAGE_LIMIT = 20

/**
 * The Who's On First repository themes an overlay build reads.
 */
export type OverlayRepositoryTheme = "admin" | "postalcode"

/**
 * The names of the per-country repositories of `themes` that the fork organization holds.
 */
export async function listWOFForks(
	themes: readonly OverlayRepositoryTheme[],
	client?: Pick<APIClient, "fetch">
): Promise<string[]> {
	const api =
		client ?? new APIClient({ displayName: "github-fork-listing", axios: { baseURL: "https://api.github.com" } })

	const patterns = themes.map((theme) => new RegExp(`^${wofRepoName(theme, "[a-z]{2}")}$`))
	const names: string[] = []

	for (let page = 1; page <= GITHUB_PAGE_LIMIT; page++) {
		const { data } = await api.fetch<Array<{ name: string }>>({
			url: `/orgs/${FORK_ORG}/repos`,
			params: { per_page: GITHUB_PAGE_SIZE, page },
		})

		names.push(
			...data.map((repository) => repository.name).filter((name) => patterns.some((pattern) => pattern.test(name)))
		)

		if (data.length < GITHUB_PAGE_SIZE) return names.toSorted()
	}

	throw new CommandError(`the ${FORK_ORG} repository listing did not end within ${GITHUB_PAGE_LIMIT} pages`)
}

/**
 * The process options of a step whose output belongs on this process's terminal.
 *
 * `runProcess` rejects on a non-zero exit by default, so a failed step stops the build.
 */
const ON_TERMINAL = { stdout: "inherit", stderr: "inherit" } as const

/**
 * What bringing the repos root current did, by repository count.
 */
export interface RepositorySyncCounts {
	/**
	 * Repositories whose `.git` came from the cache.
	 */
	restored: number
	/**
	 * Repositories the sync cloned, fast-forwarded or found current, by its action.
	 */
	actions: Record<string, number>
	/**
	 * Repositories whose `.git` was written to the cache because their head moved or the cache lacked them.
	 */
	stored: number
}

/**
 * The cache object of one repository's `.git` directory.
 */
function cacheObject(cache: string, name: string): string {
	return `${cache.replace(/\/?$/u, "/")}${name}.git.tar`
}

/**
 * The repositories the cache holds, read from one listing of its prefix.
 */
async function cachedRepositories(cache: string): Promise<Set<string>> {
	const { host: bucket, pathname } = new URL(cache.replace(/\/?$/u, "/"))
	const prefix = pathname.slice(1)

	const { stdout } = await runProcess("aws", [
		"s3api",
		"list-objects-v2",
		"--bucket",
		bucket,
		"--prefix",
		prefix,
		"--query",
		"Contents[].Key",
		"--output",
		"json",
	])

	// The query answers `null` for a prefix that holds no objects: the cache is empty.
	const keys = parseJSONStrict<string[] | null>(stdout) ?? []

	return new Set(keys.flatMap((key) => /([^/]+)\.git\.tar$/u.exec(key)?.[1] ?? []))
}

/**
 * Brings each repository in `names` current under `reposDir` the way the lab's `gazetteer inspect sync`
 * does: `syncWOFRepo` clones a missing repository at depth 1 and fast-forwards an existing one.
 *
 * The sync reads through {@linkcode wofReadOnlyOrigin}, so it needs no key and makes no GitHub write.
 * With `cache`, an `s3://` prefix, the repos root outlives the instance: each repository's `.git`
 * is restored from the cache before the sync and stored again when the sync moved its head.
 *
 * A restored repository's working tree is rebuilt from its `.git` before the sync reads it.
 * A sync that refuses a restored repository, as one with a damaged working tree, clones it afresh.
 */
async function syncRepositories(
	names: readonly string[],
	reposDir: PathBuilder,
	cache: string | null,
	onRepository: (name: string, action: string) => void
): Promise<RepositorySyncCounts> {
	const [{ inspectClone, syncWOFRepo }, { githubForkHost, wofReadOnlyOrigin }] = await Promise.all([
		import("@mailwoman/gazetteer/tools/pipeline/repos/sync"),
		import("@mailwoman/gazetteer/tools/pipeline/wof/repo-origin"),
	])

	await makeDirectories(reposDir)

	const cached = cache ? await cachedRepositories(cache) : new Set<string>()
	const counts: RepositorySyncCounts = { restored: 0, actions: {}, stored: 0 }

	const syncs = parallelMap(
		names,
		async (name) => {
			const directory = PathBuilder.from(reposDir, name)
			const archive = PathBuilder.from(reposDir, `${name}.git.tar`)

			await using client = new GitClient({ cwd: reposDir })

			if (cache && cached.has(name) && !(await pathExists(directory))) {
				await runProcess("aws", ["s3", "cp", "--only-show-errors", cacheObject(cache, name), archive], ON_TERMINAL)
				await makeDirectories(directory)
				// An archive stored on another host records that host's owner. git
				// refuses a repository whose owner differs from the user running it,
				// so the files are extracted as the restoring user's own.
				await runProcess("tar", ["-xf", archive, "-C", directory, "--no-same-owner"], ON_TERMINAL)
				await removePath(archive)
				// The archive holds the `.git` directory and no working tree.
				// The reset rebuilds the working tree, and the sync then reads the clone as clean.
				await client.read(["-C", directory.toString(), "reset", "--hard", "--quiet"])

				counts.restored++
			}

			const sync = () =>
				syncWOFRepo(name, { root: reposDir, host: githubForkHost, client, resolveOrigin: wofReadOnlyOrigin })

			// The head comes from the reader whose `state.head` the sync reports, so the two compare as equals.
			const headBefore = (await inspectClone(directory)).head

			let result = await sync()

			if (result.action.startsWith("refuse")) {
				await removePath(directory)
				result = await sync()
			}

			if (result.action.startsWith("refuse")) {
				throw new CommandError(`${name}: ${result.reason}`)
			}

			counts.actions[result.action] = (counts.actions[result.action] ?? 0) + 1
			onRepository(name, result.action)

			if (cache && result.state.head && (result.state.head !== headBefore || !cached.has(name))) {
				await runProcess("tar", ["-cf", archive, "-C", directory, ".git"], ON_TERMINAL)
				await runProcess("aws", ["s3", "cp", "--only-show-errors", archive, cacheObject(cache, name)], ON_TERMINAL)
				await removePath(archive)

				counts.stored++
			}
		},
		{ concurrency: CLONE_CONCURRENCY }
	)

	for await (const _ of syncs) {
		// Each sync runs for its effect on the repos root and the cache.
	}

	return counts
}

/**
 * Builds and publishes both overlay tile sets, and answers one report line per step.
 */
export async function buildOverlayTiles(options: BuildOverlayTilesOptions): Promise<string[]> {
	const work = PathBuilder.from(options.work)
	const phase = options.onPhase ?? (() => {})
	const report: string[] = []
	const exportDir = PathBuilder.from(work, "export")
	const rowSets = OVERLAY_ROW_SETS.filter((rowSet) => !options.rowSets || options.rowSets.includes(rowSet))
	const themes: OverlayRepositoryTheme[] = options.postcodes ? ["admin", "postalcode"] : ["admin"]

	await makeDirectories(work)

	let reposDir = options.reposDir ? PathBuilder.from(options.reposDir) : null

	if (!reposDir) {
		reposDir = PathBuilder.from(work, "wof-repos")

		const names = options.countries
			? options.countries.flatMap((country) => themes.map((theme) => wofRepoName(theme, country)))
			: await listWOFForks(themes)

		phase("sync", `${names.length} repositories${options.reposCache ? ` with the cache ${options.reposCache}` : ""}`)

		const synced = await syncRepositories(names, reposDir, options.reposCache ?? null, (name, action) =>
			phase("sync", `${name}: ${action}`)
		)

		const actions = Object.entries(synced.actions)
			.map(([action, count]) => `${count} ${action}`)
			.join(", ")

		report.push(
			`synced ${names.length} repositories → ${reposDir}: ${actions}; ${synced.restored} restored from and ${synced.stored} stored to the cache`
		)
	}

	const { exportGazetteerGeoParquet, exportWOFGeoParquet } =
		await import("@mailwoman/gazetteer/tools/pipeline/geoparquet")

	const countries = options.countries ? { countries: options.countries } : {}

	phase("export wof")

	// The `gazetteer` export reads the `wof` export's boundaries, so the `wof` export runs for either row set.
	const wof = await exportWOFGeoParquet({
		out: exportDir,
		reposDir,
		...countries,
		postcodes: options.postcodes === true,
		// Clones synced into the work directory get their record store beside them; `--repos` clones reuse theirs.
		...(options.reposDir ? {} : { recordStore: PathBuilder.from(work, "wof-records.db") }),
		onProgress: (counts) => phase("export wof", `${counts.read} records read`),
	})

	report.push(
		`wof export: ${wof.counts.read} records read, ${wof.counts.notIngested} left out as the admin intake leaves them, ` +
			`${wof.counts.deprecated} deprecated and ${wof.counts.ceased} ceased kept, ` +
			`${wof.counts.boundaries} boundaries, ${wof.counts.points} points, ` +
			`${wof.counts.unreadable} unreadable`
	)

	if (rowSets.includes("gazetteer")) {
		if (!options.admin) throw new CommandError("the gazetteer row set reads the admin database: pass --admin")

		let adminPath = options.admin

		if (adminPath.startsWith("s3://")) {
			adminPath = PathBuilder.from(work, "admin.db").toString()

			if (!(await pathExists(adminPath))) {
				phase("admin", options.admin)

				await runProcess("aws", ["s3", "cp", "--only-show-errors", options.admin, adminPath], ON_TERMINAL)
			}
		}

		const gazetteer = await exportGazetteerGeoParquet({
			out: exportDir,
			adminPath,
			...countries,
			onPhase: (name, detail) => phase(`export gazetteer: ${name}`, detail),
		})

		const boundaries = Object.entries(gazetteer.counts.boundaries)
			.map(([source, count]) => `${count} ${source}`)
			.join(", ")

		report.push(
			`gazetteer export: ${gazetteer.counts.places} places, boundaries ${boundaries}, ${gazetteer.counts.extents} extents, ` +
				`${gazetteer.counts.overturePlacesMapped} of ${gazetteer.counts.overturePlaces} Overture places mapped`
		)
	}

	if (options.exportCopy) {
		phase("copy export", options.exportCopy)

		await runProcess("aws", ["s3", "sync", "--only-show-errors", exportDir, options.exportCopy], ON_TERMINAL)

		report.push(`export copied → ${options.exportCopy}`)
	}

	// The `wof` postcodes go to a tile set of their own, `wof-postcodes`, because they
	// outnumber every other placetype and a client downloads every layer of a tile it requests.
	const archives = rowSets.flatMap((rowSet) => [
		{ rowSet, name: rowSet, flags: [] as string[] },
		...(rowSet === "wof" && options.postcodes
			? [{ rowSet, name: `${rowSet}-postcodes`, flags: ["postcodes-only"] }]
			: []),
	])

	for (const { rowSet, name, flags } of archives) {
		const archive = PathBuilder.from(work, `${name}.${options.version}.pmtiles`).toString()

		phase(`tiles ${name}`)

		await runProcess(
			options.hrt ?? "hrt",
			[
				"overlay",
				PathBuilder.from(exportDir, `rowset=${rowSet}`),
				archive,
				...(typeof options.maxZoom === "number" ? [`max-zoom=${options.maxZoom}`] : []),
				...flags,
			],
			ON_TERMINAL
		)

		phase(`publish ${name}`)

		report.push(
			await publishTiles({
				file: archive,
				tileset: `${name}.${options.version}`,
				bucket: options.bucket,
				prefix: options.prefix,
				dryRun: options.dryRun,
			})
		)
	}

	return report
}
