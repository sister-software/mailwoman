/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Reports the provenance of the artifacts under the engine and never repairs, because the repairs change what the next
 * build ingests and a read-only answer is safe to ask at any moment.
 */

import { pathExists, readLink, readLocalJSONFile, statLink, statPath } from "@mailwoman/core/fs/readers"
import type { PathBuilderLike } from "path-ts"

interface ArtifactState {
	name: string
	path: string
	exists: boolean
	/**
	 * Bytes, or `null` when absent; a size that moved is the cheapest signal that a swap happened.
	 */
	bytes: number | null
	modified: string | null
	/**
	 * The link target when the path is a symlink; `candidate.db` is a pointer `gazetteer promote`
	 * swaps, so the target name carries the build's identity and the path alone does not.
	 */
	linkTarget: string | null
	/**
	 * `true` when the file is read-only; an owner-writable artifact is mid-build
	 * or one a verify step refused, and must never be measured against as if it had passed.
	 */
	sealed: boolean | null
}

interface RepoVintage {
	repo: string
	origin: string
	source: string
	head: string | null
	headDate: string | null
	shallow: boolean | null
}

/**
 * What a provenance snapshot found: the artifacts, the repo stamp and the admin build log behind the engine.
 */
export interface ProvenanceReport {
	dataRoot: string
	artifacts: ArtifactState[]
	/**
	 * Read from the stamp `gazetteer repos-sync` writes, or `null` when that has never been
	 * run here — absence is reported rather than read as "the repos are current".
	 */
	repos: RepoVintage[] | null
	reposStampPath: string
	reposStampAge: string | null
	/**
	 * The last entries of the admin build log: what was built, from which Overture
	 * release, and whether it was swapped.
	 */
	buildLog: string[]
	notes: string[]
}

async function artifactState(name: string, path: PathBuilderLike): Promise<ArtifactState> {
	if (!(await pathExists(path))) {
		return { name, path: path.toString(), exists: false, bytes: null, modified: null, linkTarget: null, sealed: null }
	}

	const link = await statLink(path)
	const stat = await statPath(path)

	return {
		name,
		path: path.toString(),
		exists: true,
		bytes: stat.size,
		modified: stat.mtime.toISOString(),
		linkTarget: link.isSymbolicLink() ? await readLink(path) : null,
		// A finished database is sealed 0444; owner-write means it is not finished.
		sealed: (stat.mode & 0o200) === 0,
	}
}

/**
 * Options for {@link runProvenance}.
 */
export interface ProvenanceOptions {
	/**
	 * Extra artifact paths to report beside the standard set, e.g. a scratch build under measurement.
	 */
	extra?: readonly string[]
	buildLogEntries?: number
}

/**
 * Assemble the provenance report, reading every field and reporting an absent
 * file as absent rather than defaulted.
 */
export async function runProvenance(options: ProvenanceOptions = {}): Promise<ProvenanceReport> {
	const { dataRootPath } = await import("@mailwoman/core/data-root")
	const { repoRootPath } = await import("@mailwoman/core/paths")
	const { poiDatabasePath, wofDatabasePath } = await import("@mailwoman/resolver-wof-sqlite/paths")

	const dataRoot = dataRootPath()

	// wof-hot.db belongs to the staged demo rather than the data root, so use `promotion-eval.ts`'s lookup order.
	const { resolveWOFHotDB } = await import("mailwoman/eval-harness/wof-hot-db")

	const standard: Array<readonly [string, PathBuilderLike]> = [
		["admin", wofDatabasePath("admin-global-priority.db")],
		["candidate", wofDatabasePath("candidate.db")],
		["importance", wofDatabasePath("admin-global-priority-importance.db")],
		["poi", poiDatabasePath("poi.db")],
		["wof-hot", resolveWOFHotDB()],
	]

	const artifacts = [
		...(await Promise.all(standard.map(async ([name, path]) => artifactState(name, path)))),
		...(await Promise.all((options.extra ?? []).map(async (path) => artifactState("extra", path)))),
	]

	const reposStampPath = wofDatabasePath("repos-vintage.json")
	let repos: RepoVintage[] | null = null
	let reposStampAge: string | null = null

	if (await pathExists(reposStampPath)) {
		try {
			const stamp = (await readLocalJSONFile(reposStampPath)) as { repos?: RepoVintage[] }

			repos = stamp.repos ?? []
			reposStampAge = (await statPath(reposStampPath)).mtime.toISOString()
		} catch {
			// A corrupt stamp is reported as no stamp; guessing at its contents would be worse than reporting no value.
			repos = null
		}
	}

	const buildLogPath = repoRootPath("data", "gazetteer", "wof-build-manifest.json")
	let buildLog: string[] = []

	if (await pathExists(buildLogPath)) {
		try {
			// The build appends one dated line per build to `notes` — carrying the record counts,
			// the Overture release and whether it was swapped — verified against the
			// committed file rather than assumed from the key's name.
			const log = (await readLocalJSONFile(buildLogPath)) as { notes?: unknown }
			const entries = Array.isArray(log.notes) ? log.notes.filter((n): n is string => typeof n === "string") : []

			buildLog = entries.slice(-(options.buildLogEntries ?? 3))
		} catch {
			buildLog = []
		}
	}

	const notes: string[] = []

	if (!repos) {
		notes.push(
			`no repo vintage stamp at ${reposStampPath} — run \`mailwoman gazetteer repos-sync\`. Its ABSENCE says the ` +
				`repos root has not been surveyed, NOT that it is current.`
		)
	}

	const unsealed = artifacts.filter((a) => a.exists && a.sealed === false)

	if (unsealed.length) {
		notes.push(
			`UNSEALED (owner-writable): ${unsealed.map((a) => a.name).join(", ")} — a finished build is sealed 0444, so ` +
				`this is either mid-build or an artifact a verify check refused. Do not grade against it.`
		)
	}

	const stale = (repos ?? []).filter((r) => r.headDate && Date.parse(r.headDate) < Date.now() - 365 * 86_400_000)

	if (stale.length) {
		notes.push(
			`repos older than a year: ${stale.map((r) => `${r.repo} (${r.headDate?.slice(0, 10)})`).join(", ")} — the ` +
				`build reads whatever is on disk and will not mention it.`
		)
	}

	const upstreamPointed = (repos ?? []).filter((r) => r.source === "upstream")

	if (upstreamPointed.length) {
		notes.push(
			`${upstreamPointed.length} repo(s) resolve to upstream. That is correct where no fork exists; where one does, ` +
				`a sync pulls upstream over our corrections. \`gazetteer repos-sync\` names which is which.`
		)
	}

	return {
		dataRoot: dataRoot.toString(),
		artifacts,
		repos,
		reposStampPath: reposStampPath.toString(),
		reposStampAge,
		buildLog,
		notes,
	}
}
