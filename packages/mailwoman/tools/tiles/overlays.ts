// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Builds the two gazetteer overlay tile sets from their sources in one run: `wof`,
 *   the Who's On First clones, and `gazetteer`, the places of the admin database.
 *
 *   The run fetches what its work directory lacks, so it starts from an empty disk:
 *
 *   1. It clones each admin repository from its `mailwoman` fork at depth 1.
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
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { runProcess } from "@mailwoman/core/process"
import { CommandError } from "@mailwoman/core/scripting/command"
import { FORK_ORG, repoReadURL } from "@mailwoman/gazetteer/tools/pipeline/wof/repo-origin"
import { wofRepoName } from "@mailwoman/gazetteer/whosonfirst/extract-repo"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { parallelMap } from "spliterator"

import { publishTiles } from "#tools/tiles/publish"

/**
 * The row sets that each get a tile set, in build order: the gazetteer export
 * reads the `wof` export's boundaries.
 */
export const OVERLAY_ROW_SETS = ["wof", "gazetteer"] as const

export type OverlayRowSet = (typeof OVERLAY_ROW_SETS)[number]

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
	 * The admin database: a local path, or an `s3://` URL the run copies into the work directory.
	 */
	admin: string
	/**
	 * Lower-case country codes to build, or every country when absent.
	 */
	countries?: readonly string[]
	/**
	 * A directory of existing clones.
	 * The run clones into the work directory when absent.
	 */
	reposDir?: PathBuilderLike
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
 * The names of the admin repositories the fork organization holds, one per country.
 */
export async function listAdminForks(client?: Pick<APIClient, "fetch">): Promise<string[]> {
	const api =
		client ?? new APIClient({ displayName: "github-fork-listing", axios: { baseURL: "https://api.github.com" } })

	const admin = new RegExp(`^${wofRepoName("admin", "[a-z]{2}")}$`)
	const names: string[] = []

	for (let page = 1; page <= GITHUB_PAGE_LIMIT; page++) {
		const { data } = await api.fetch<Array<{ name: string }>>({
			url: `/orgs/${FORK_ORG}/repos`,
			params: { per_page: GITHUB_PAGE_SIZE, page },
		})

		names.push(...data.map((repository) => repository.name).filter((name) => admin.test(name)))

		if (data.length < GITHUB_PAGE_SIZE) return names.toSorted()
	}

	throw new CommandError(`the ${FORK_ORG} repository listing did not end within ${GITHUB_PAGE_LIMIT} pages`)
}

/**
 * Runs a program with its output on this process's terminal, and throws when it exits non-zero.
 */
async function runProgram(program: string, args: readonly string[]): Promise<void> {
	const result = await runProcess(program, args, { reject: false, stdout: "inherit", stderr: "inherit" })

	if (result.exitCode !== 0) {
		throw new CommandError(`${program} ${args.join(" ")} exited ${result.exitCode}`)
	}
}

/**
 * Clones each repository in `names` that the directory lacks, at depth 1, and answers the count it cloned.
 */
async function cloneRepositories(names: readonly string[], reposDir: PathBuilder): Promise<number> {
	await makeDirectories(reposDir)

	let cloned = 0

	const clones = parallelMap(
		names,
		async (name) => {
			const directory = PathBuilder.from(reposDir, name)

			if (await pathExists(directory)) return

			await runProgram("git", ["clone", "--quiet", "--depth", "1", repoReadURL(FORK_ORG, name), directory.toString()])

			cloned++
		},
		{ concurrency: CLONE_CONCURRENCY }
	)

	for await (const _ of clones) {
		// The clones run for their effect.
	}

	return cloned
}

/**
 * Builds and publishes both overlay tile sets, and answers one report line per step.
 */
export async function buildOverlayTiles(options: BuildOverlayTilesOptions): Promise<string[]> {
	const work = PathBuilder.from(options.work)
	const phase = options.onPhase ?? (() => {})
	const report: string[] = []
	const exportDir = PathBuilder.from(work, "export")

	await makeDirectories(work)

	let reposDir = options.reposDir ? PathBuilder.from(options.reposDir) : null

	if (!reposDir) {
		reposDir = PathBuilder.from(work, "wof-repos")

		const names = options.countries
			? options.countries.map((country) => wofRepoName("admin", country))
			: await listAdminForks()

		phase("clone", `${names.length} repositories`)

		report.push(`cloned ${await cloneRepositories(names, reposDir)} of ${names.length} repositories → ${reposDir}`)
	}

	let adminPath = options.admin

	if (adminPath.startsWith("s3://")) {
		adminPath = PathBuilder.from(work, "admin.db").toString()

		if (!(await pathExists(adminPath))) {
			phase("admin", options.admin)

			await runProgram("aws", ["s3", "cp", "--only-show-errors", options.admin, adminPath])
		}
	}

	const { exportGazetteerGeoParquet, exportWOFGeoParquet } =
		await import("@mailwoman/gazetteer/tools/pipeline/geoparquet")

	const countries = options.countries ? { countries: options.countries } : {}

	phase("export wof")

	const wof = await exportWOFGeoParquet({ out: exportDir, reposDir, ...countries })

	report.push(
		`wof export: ${wof.counts.read} records, ${wof.counts.boundaries} boundaries, ${wof.counts.points} points, ` +
			`${wof.counts.unreadable} unreadable`
	)

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

	if (options.exportCopy) {
		phase("copy export", options.exportCopy)

		await runProgram("aws", ["s3", "sync", "--only-show-errors", exportDir.toString(), options.exportCopy])

		report.push(`export copied → ${options.exportCopy}`)
	}

	for (const rowSet of OVERLAY_ROW_SETS) {
		const archive = PathBuilder.from(work, `${rowSet}.${options.version}.pmtiles`).toString()

		phase(`tiles ${rowSet}`)

		await runProgram(options.hrt ?? "hrt", [
			"overlay",
			PathBuilder.from(exportDir, `rowset=${rowSet}`).toString(),
			archive,
			...(typeof options.maxZoom === "number" ? [`max-zoom=${options.maxZoom}`] : []),
		])

		phase(`publish ${rowSet}`)

		report.push(
			await publishTiles({
				file: archive,
				tileset: `${rowSet}.${options.version}`,
				bucket: options.bucket,
				prefix: options.prefix,
				dryRun: options.dryRun,
			})
		)
	}

	return report
}
