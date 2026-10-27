/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Lists the input files that changed since a corpus source's files were built from a directory of git checkouts.
 *
 *   Each parquet record stores the HEAD commit of every checkout its rows were read from. The diff from that commit
 *   to the checkout's current HEAD, plus the checkout's uncommitted files, is the set of input files a rebuild would
 *   read differently. Who's On First stores each record in a file whose name begins with the record's id, so each
 *   changed path also gives the WOF id of the record that changed.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { changedFiles, git } from "@mailwoman/core/git"
import { basename, type PathBuilderLike, resolvePath } from "path-ts"

import { inputCheckoutStates, mergeInputCheckouts, readParquetRecord } from "#parquet/record"
import { baseManifestFiles, localManifestFilePath } from "#tools/overlay/manifest"

/**
 * Options for {@link listInputChanges}.
 */
export interface InputChangesOptions {
	/**
	 * The corpus `MANIFEST.json` whose files are compared.
	 */
	manifestPath: PathBuilderLike
	/**
	 * The manifest source whose files are compared, such as `wof-admin`.
	 */
	source: string
	/**
	 * The directory holding the checkouts, as the build read it, such as `$MAILWOMAN_DATA_ROOT/src/wof-repos`.
	 */
	inputRoot: PathBuilderLike
	/**
	 * The time the rows were read, for files whose records store no commits.
	 *
	 * Each checkout's base is then its last commit before this time.
	 * A file merged from an earlier build records its own `builtAt`, which is later
	 * than the read, so the caller states the read time.
	 */
	at?: string
}

/**
 * How a checkout's base commit was found.
 */
export const BaseCommitOrigin = {
	/**
	 * The file records stored the commit.
	 */
	Recorded: "recorded",
	/**
	 * The commit is the checkout's last commit before {@linkcode InputChangesOptions.at}.
	 */
	LastBeforeAt: "last-before-at",
} as const

export type BaseCommitOrigin = (typeof BaseCommitOrigin)[keyof typeof BaseCommitOrigin]

/**
 * One input file that differs from the state the corpus files were built from.
 */
export interface ChangedInputFile {
	checkout: string
	path: string
	/**
	 * `committed` for a file a commit after the base changed, `uncommitted` for
	 * a file `git status` reports now.
	 */
	change: "committed" | "uncommitted"
	/**
	 * The WOF id at the start of the file name, or `null` for a file that is no WOF record,
	 * such as a directory `git status` collapses or a `LICENSE.md`.
	 */
	wofID: number | null
}

/**
 * One checkout's comparison.
 */
export interface CheckoutComparison {
	checkout: string
	/**
	 * The commit the rows were read from, or `null` when the checkout held no commit before `at`.
	 */
	base: string | null
	origin: BaseCommitOrigin
	head: string
	/**
	 * The uncommitted-file count the records stored for the checkout, or `null` when they stored none.
	 */
	uncommittedAtBuild: number | null
	changed: ChangedInputFile[]
}

/**
 * The comparison of one manifest source against the current checkouts.
 */
export interface InputChanges {
	source: string
	files: number
	origin: BaseCommitOrigin
	checkouts: CheckoutComparison[]
	/**
	 * Checkouts the records store that the input root no longer holds.
	 */
	missing: string[]
}

const WOF_FILE = /^(\d+)(?:-alt-[^.]+)?\.geojson$/u

/**
 * The WOF id in a path's file name, or `null`.
 */
export function geojsonFileWOFID(path: string): number | null {
	const match = WOF_FILE.exec(basename(path))

	return match ? Number(match[1]) : null
}

/**
 * The path a `git status --porcelain` line reports, taking the new path of a rename.
 */
function statusPath(line: string): string {
	const path = line.slice(3)
	const arrow = path.indexOf(" -> ")

	return arrow !== -1 ? path.slice(arrow + 4) : path
}

/**
 * Compare the commits a manifest source's files were built from with the checkouts under `inputRoot` now.
 *
 * @throws When the source has no files in the manifest, when a file has no readable record, when the
 * records store no commits and `at` is absent, or when some records store commits and others do not.
 */
export async function listInputChanges(options: InputChangesOptions): Promise<InputChanges> {
	const manifest = await readLocalJSONFile<object>(options.manifestPath)

	const files = baseManifestFiles<{ path: string; source?: string }>(manifest).filter(
		(file) => file.source === options.source
	)

	if (!files.length) throw new Error(`listInputChanges: ${options.manifestPath} lists no ${options.source} file`)

	const records = await Promise.all(
		files.map(async (file) => {
			const local = localManifestFilePath(file.path)
			const record = await readParquetRecord(local)

			if (!record) throw new Error(`listInputChanges: ${local} has no readable record`)

			return record
		})
	)

	const unrecorded = records.filter((record) => !record.derivation.inputRevisions).length

	if (unrecorded && unrecorded < records.length) {
		throw new Error(
			`listInputChanges: ${unrecorded} of ${records.length} ${options.source} records store no commits, so no one base describes the source`
		)
	}

	const recorded = mergeInputCheckouts(records.map((record) => record.derivation))

	if (!recorded && !options.at) {
		throw new Error(
			`listInputChanges: the ${records.length} ${options.source} records store no commits; pass the time the rows were read as "at"`
		)
	}

	const states = await inputCheckoutStates(options.inputRoot)
	const present = new Set(states.map((state) => state.checkout))
	const origin = recorded ? BaseCommitOrigin.Recorded : BaseCommitOrigin.LastBeforeAt
	const checkouts: CheckoutComparison[] = []

	for (const state of states) {
		const dir = resolvePath(options.inputRoot, state.checkout)

		const base = recorded
			? (recorded.inputRevisions[state.checkout] ?? null)
			: (await git(["rev-list", "-1", `--before=${options.at}`, "HEAD"], dir)) || null

		if (recorded && !base) continue

		const committed = base && base !== state.head ? await changedFiles(dir, base, state.head) : []

		const changed: ChangedInputFile[] = [
			...committed.map((path) => ({ checkout: state.checkout, path, change: "committed" as const })),
			...state.status.map((line) => ({
				checkout: state.checkout,
				path: statusPath(line),
				change: "uncommitted" as const,
			})),
		].map((file) => ({ ...file, wofID: geojsonFileWOFID(file.path) }))

		checkouts.push({
			checkout: state.checkout,
			base,
			origin,
			head: state.head,
			uncommittedAtBuild: recorded?.inputUncommittedFiles[state.checkout] ?? null,
			changed,
		})
	}

	const missing = recorded ? Object.keys(recorded.inputRevisions).filter((checkout) => !present.has(checkout)) : []

	return { source: options.source, files: files.length, origin, checkouts, missing }
}
