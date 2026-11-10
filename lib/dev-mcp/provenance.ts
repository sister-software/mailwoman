/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Reports the provenance of the artifacts under the engine and never repairs, because the repairs change what the next
 * build ingests and a read-only answer is safe to ask at any moment.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists, readLink, statLink, statPath } from "@mailwoman/core/fs/readers/stat"
import { allKeyed } from "@mailwoman/core/promises"
import type { PathBuilderLike } from "path-ts"

interface ArtifactState {
	name: string
	path: string
	exists: boolean
	/**
	 * Bytes, or `null` when absent.
	 *
	 * A size that moved is the cheapest signal that a swap happened.
	 */
	bytes: number | null
	modified: string | null
	/**
	 * The link target when the path is a symlink.
	 *
	 * `candidate.db` is a pointer `gazetteer promote` swaps, so the target name
	 * identifies the build and the path by itself does not.
	 */
	linkTarget: string | null
	/**
	 * `true` when the file is read-only.
	 *
	 * An owner-writable artifact is mid-build or a verify step refused it.
	 * Do not measure it as a verified artifact.
	 */
	sealed: boolean | null
}

interface RepoVintage {
	repo: string
	originURL: string | null
	/**
	 * Whether the clone's `origin` is its `mailwoman` fork.
	 * A stamp written before this field existed lacks it.
	 */
	onFork?: boolean
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
	 * Read from the stamp `gazetteer inspect sync` writes, or `null` when that has never
	 * been run here — absence is reported rather than read as "the repos are current".
	 */
	repos: RepoVintage[] | null
	reposStampPath: string
	reposStampAge: string | null
	/**
	 * The last entries of the admin build log record the built artifact and its Overture release.
	 * They also record whether the artifact was swapped.
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
		// A finished database is sealed 0444, so owner-write means it is unfinished.
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
	const {
		dataRoot: { dataRootPath },
		paths: { repoRootPath },
		paths2: { poiDatabasePath, wofDatabasePath },
	} = await allKeyed({
		dataRoot: import("@mailwoman/core/data-root"),
		paths: import("@mailwoman/core/paths"),
		paths2: import("@mailwoman/resolver-wof-sqlite/paths"),
	})

	const dataRoot = dataRootPath()

	// wof-hot.db belongs to the staged demo rather than the data root, so use `promotion-eval.ts`'s lookup order.
	const { resolveWOFHotDB } = await import("mailwoman/tools/eval-harness/wof-hot-db")

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
			const stamp = await readLocalJSONFile<{ repos?: RepoVintage[] }>(reposStampPath)

			repos = stamp.repos ?? []
			reposStampAge = (await statPath(reposStampPath)).mtime.toISOString()
		} catch {
			// A corrupt stamp is reported as no stamp.
			// A guessed value would be worse than reporting no value.
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
			const log = await readLocalJSONFile<{ notes?: unknown }>(buildLogPath)
			const entries = Array.isArray(log.notes) ? log.notes.filter((n): n is string => typeof n === "string") : []

			buildLog = entries.slice(-(options.buildLogEntries ?? 3))
		} catch {
			buildLog = []
		}
	}

	const notes: string[] = []

	if (!repos) {
		notes.push(
			`no repo vintage stamp at ${reposStampPath} — run \`mailwoman gazetteer inspect sync\`. Its ABSENCE says the ` +
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

	const offFork = (repos ?? []).filter((r) => r.onFork === false)
	const unstated = (repos ?? []).filter((r) => typeof r.onFork !== "boolean")

	if (offFork.length) {
		notes.push(
			`${offFork.length} clone(s) fetch origin from somewhere other than their mailwoman fork: ` +
				`${offFork.map((r) => `${r.repo} (${r.originURL ?? "no origin"})`).join(", ")}. ` +
				`\`gazetteer inspect sync\` re-points them.`
		)
	}

	if (unstated.length) {
		notes.push(
			`${unstated.length} stamp row(s) do not record whether the clone fetches from its fork; the stamp predates ` +
				`that field. Run \`gazetteer inspect sync\` to rewrite it.`
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
