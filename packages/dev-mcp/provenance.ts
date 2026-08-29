/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   WHAT AM I MEASURING AGAINST — the provenance of the artifacts under the engine, before any number is believed.
 *
 *   Every other tool here answers a question about behaviour. This one answers the question that decides whether those
 *   answers mean anything, because a gazetteer artifact carries no complaint when it is wrong: `ingestWOF` globs a
 *   directory and builds whatever is there, so a repo six months stale, a checkout still pulled from upstream over our
 *   corrections, or a database swapped an hour ago all produce a plausible artifact and a confident answer.
 *
 *   Three failures from one evening, none of which any measurement would have surfaced:
 *
 *   - The admin build's Overture pin named a release Overture had PRUNED. The build ran the full 2.9M-record WOF ingest
 *       and then failed at `fold-overture` with `IO Error: No files found`, which reads as a network fault.
 *   - `inspect sync` could only ever clone upstream, so a sync on any machine would have pulled upstream data straight
 *       over 35 records we correct — successfully, silently.
 *   - The repos root's vintages ranged from 2026-03 to **2017-12**, and no build step could see it.
 *
 *   REPORTS, NEVER REPAIRS. The repairs live in `gazetteer repos-sync` and `gazetteer inspect sync`, which are opt-in
 *   because they change what the next build ingests. A read-only answer is safe to ask at any moment, including in the
 *   middle of someone else's build.
 */

import { parseJSONStrict } from "@mailwoman/core/objects"
import { existsSync, lstatSync, readlinkSync, statSync } from "@mailwoman/platform/fs"

interface ArtifactState {
	name: string
	path: string
	exists: boolean
	/**
	 * Bytes, or `null` when absent. A size that moved is the cheapest signal that a swap happened.
	 */
	bytes: number | null
	modified: string | null
	/**
	 * The link target when the path is a symlink. `candidate.db` is a POINTER by design — `gazetteer promote` swaps it —
	 * so the target name carries the build's identity and the path alone does not.
	 */
	linkTarget: string | null
	/**
	 * `true` when the file is read-only, which is how a sealed build is distinguished from one still being written. An
	 * unsealed artifact is one a verify gate refused, and must never be measured against as if it had passed.
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

export interface ProvenanceReport {
	dataRoot: string
	artifacts: ArtifactState[]
	/**
	 * Read from the stamp `gazetteer repos-sync` writes. Absent when that has never been run here — which is reported as
	 * absence, not as "the repos are current".
	 */
	repos: RepoVintage[] | null
	reposStampPath: string
	reposStampAge: string | null
	/**
	 * The last entries of the admin build log — what was built, from which Overture release, and whether it was swapped.
	 */
	buildLog: string[]
	notes: string[]
}

function artifactState(name: string, path: string): ArtifactState {
	if (!existsSync(path)) {
		return { name, path, exists: false, bytes: null, modified: null, linkTarget: null, sealed: null }
	}

	const link = lstatSync(path)
	const stat = statSync(path)

	return {
		name,
		path,
		exists: true,
		bytes: stat.size,
		modified: stat.mtime.toISOString(),
		linkTarget: link.isSymbolicLink() ? readlinkSync(path) : null,
		// The house convention seals a finished database 0444. Owner-write means it is not finished.
		sealed: (stat.mode & 0o200) === 0,
	}
}

export interface ProvenanceOptions {
	/**
	 * Extra artifact paths to report beside the standard set — a scratch build under measurement, say.
	 */
	extra?: readonly string[]
	buildLogEntries?: number
}

/**
 * Assemble the provenance report. Every field is READ; nothing is derived from a convention that might not hold, which
 * is why an absent file is reported as absent rather than defaulted.
 */
export async function runProvenance(options: ProvenanceOptions = {}): Promise<ProvenanceReport> {
	const { dataRootPath, mailwomanDataRoot, repoRootPath } = await import("@mailwoman/core/utils")
	const { readFileSync } = await import("@mailwoman/platform/fs")

	const dataRoot = String(mailwomanDataRoot())

	// wof-hot.db belongs to the staged demo rather than the data root. Use the promotion gate's lookup order so this
	// report states the path that the demo-cascade test checks (#524).
	const { resolveWOFHotDB } = await import("mailwoman/eval-harness/wof-hot-db")

	const standard: Array<readonly [string, string]> = [
		["admin", String(dataRootPath("wof", "admin-global-priority.db"))],
		["candidate", String(dataRootPath("wof", "candidate.db"))],
		["importance", String(dataRootPath("wof", "admin-global-priority-importance.db"))],
		["poi", String(dataRootPath("poi", "poi.db"))],
		["wof-hot", resolveWOFHotDB()],
	]

	const artifacts = [
		...standard.map(([name, path]) => artifactState(name, path)),
		...(options.extra ?? []).map((path) => artifactState("extra", path)),
	]

	const reposStampPath = String(dataRootPath("wof", "repos-vintage.json"))
	let repos: RepoVintage[] | null = null
	let reposStampAge: string | null = null

	if (existsSync(reposStampPath)) {
		try {
			const stamp = parseJSONStrict(readFileSync(reposStampPath, "utf8")) as { repos?: RepoVintage[] }

			repos = stamp.repos ?? []
			reposStampAge = statSync(reposStampPath).mtime.toISOString()
		} catch {
			// A corrupt stamp is reported as no stamp. Guessing at its contents would be worse than saying nothing.
			repos = null
		}
	}

	const buildLogPath = String(repoRootPath("scripts", "wof-build-manifest.json"))
	let buildLog: string[] = []

	if (existsSync(buildLogPath)) {
		try {
			// The build appends to `notes` — verified against the committed file, not assumed from the key's name. Each
			// entry is one dated line carrying the record counts, the Overture release and whether it was swapped live.
			const log = parseJSONStrict(readFileSync(buildLogPath, "utf8")) as { notes?: unknown }
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
				`this is either mid-build or an artifact a verify gate refused. Do not grade against it.`
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

	return { dataRoot, artifacts, repos, reposStampPath, reposStampAge, buildLog, notes }
}
