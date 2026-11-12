// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Where a Who's On First clone fetches from, and the GitHub operations that keep that source current.
 *
 *   Every clone's `origin` is the `mailwoman` fork of its repository,
 *   and its `upstream` remote is the original.
 *   Corrections are committed to the fork and proposed upstream from there.
 *
 *   A GitHub fork doesn't follow its parent, so the sync merges upstream into each
 *   fork on GitHub before a clone fetches from it.
 */

import { errorMessage } from "@mailwoman/core/errors/schema"
import { isProcessError, runFile } from "@mailwoman/core/process"
import { sleep } from "@mailwoman/core/utils/sleep"

import { WOF_DATA_OWNER } from "#whosonfirst/extract-repo"
import { PLACETYPES_REPO } from "#whosonfirst/placetypes/Placetype"

/**
 * The GitHub organization that owns our forks.
 */
export const FORK_ORG = "mailwoman"

/**
 * The repository that lists the IDs the forks removed, each with its successors.
 *
 * `mailwoman` created it, so it has no original in `whosonfirst-data`.
 * Its clone has no `upstream` remote, and the sync never forks or merges it.
 */
export const WOF_DEPRECATED_REPO = "whosonfirst-data-deprecated"

/**
 * The remotes a clone of one repository has.
 */
export interface RepoOrigin {
	repo: string
	/**
	 * The `origin` remote: our fork, or our own repository when it has no original.
	 */
	forkURL: string
	/**
	 * The organization holding the original repository, or `null` for a repository `mailwoman` created.
	 */
	upstreamOrg: string | null
	/**
	 * The `upstream` remote: the original repository, or `null` when there's none.
	 */
	upstreamURL: string | null
}

/**
 * Returns the GitHub SSH remote URL for an org and repo.
 */
export function repoURL(org: string, repo: string): string {
	return `ssh://git@github.com/${org}/${repo}`
}

/**
 * The organization holding a repository's original.
 *
 * The placetypes repository is the one Who's On First repository outside `whosonfirst-data`,
 * and {@linkcode WOF_DEPRECATED_REPO} has no original.
 */
export function upstreamOrgOf(repo: string): string | null {
	if (repo === WOF_DEPRECATED_REPO) return null

	return repo === PLACETYPES_REPO.name ? PLACETYPES_REPO.upstreamOwner : WOF_DATA_OWNER
}

/**
 * The remotes for a repository's clone.
 */
export function wofRepoOrigin(repo: string): RepoOrigin {
	const upstreamOrg = upstreamOrgOf(repo)

	return {
		repo,
		forkURL: repoURL(FORK_ORG, repo),
		upstreamOrg,
		upstreamURL: upstreamOrg ? repoURL(upstreamOrg, repo) : null,
	}
}

/**
 * What merging upstream into a fork did on GitHub.
 *
 * `conflict` means the fork's corrections and upstream's new commits touch the same lines.
 * GitHub leaves the fork unchanged, and a person merges it by hand.
 */
export type ForkUpdate =
	| { kind: "fast-forward" | "merge" | "none"; branch: string }
	| { kind: "conflict"; branch: string; message: string }

/**
 * The GitHub operations the sync needs.
 * Tests inject a stub in place of GitHub.
 */
export interface ForkHost {
	/**
	 * Creates `mailwoman/<repo>` as a fork of the original when it doesn't exist.
	 *
	 * @returns `true` when this call created the fork.
	 */
	ensureFork(origin: RepoOrigin): Promise<boolean>
	/**
	 * Merges the original's default branch into the fork's matching branch.
	 */
	updateFork(origin: RepoOrigin): Promise<ForkUpdate>
}

/**
 * Seconds to wait for a newly requested fork to appear.
 *
 * GitHub answers a fork request at once and copies the repository afterward.
 * The large country repositories take tens of seconds.
 */
const FORK_READY_TIMEOUT_SECONDS = 300

/**
 * A failed `gh` call's message and standard error together, where `gh` writes the HTTP status.
 */
function ghErrorText(error: unknown): string {
	return isProcessError(error) ? `${error.message}${error.stderr}` : errorMessage(error)
}

function isNotFound(error: unknown): boolean {
	return /HTTP 404|Not Found/i.test(ghErrorText(error))
}

async function readDefaultBranch(org: string, repo: string): Promise<string | null> {
	try {
		const { stdout } = await runFile("gh", ["api", `/repos/${org}/${repo}`, "--jq", ".default_branch"])

		return stdout.trim() || null
	} catch (error) {
		if (isNotFound(error)) return null

		throw error
	}
}

/**
 * {@link ForkHost} through the `gh` CLI.
 */
export const githubForkHost: ForkHost = {
	async ensureFork(origin) {
		if (await readDefaultBranch(FORK_ORG, origin.repo)) return false

		if (!origin.upstreamOrg) throw new Error(`${FORK_ORG}/${origin.repo} does not exist and has no original to fork`)

		await runFile("gh", [
			"api",
			"--method",
			"POST",
			`/repos/${origin.upstreamOrg}/${origin.repo}/forks`,
			"-f",
			`organization=${FORK_ORG}`,
			"-F",
			"default_branch_only=true",
		])

		const deadline = Date.now() + FORK_READY_TIMEOUT_SECONDS * 1000

		while (Date.now() < deadline) {
			if (await readDefaultBranch(FORK_ORG, origin.repo)) return true

			await sleep(5000)
		}

		throw new Error(
			`${FORK_ORG}/${origin.repo} did not appear within ${FORK_READY_TIMEOUT_SECONDS}s of the fork request`
		)
	},

	async updateFork(origin) {
		const branch = await readDefaultBranch(FORK_ORG, origin.repo)

		if (!branch) throw new Error(`${FORK_ORG}/${origin.repo} does not exist`)

		try {
			const { stdout } = await runFile("gh", [
				"api",
				"--method",
				"POST",
				`/repos/${FORK_ORG}/${origin.repo}/merge-upstream`,
				"-f",
				`branch=${branch}`,
				"--jq",
				".merge_type",
			])

			const kind = stdout.trim()

			if (kind !== "fast-forward" && kind !== "merge" && kind !== "none") {
				throw new Error(`merge-upstream for ${FORK_ORG}/${origin.repo} answered merge_type "${kind}"`)
			}

			return { kind, branch }
		} catch (error) {
			const text = ghErrorText(error)

			// GitHub answers 409 when the merge conflicts and 422 when the branches cannot be merged automatically.
			if (/HTTP 409|HTTP 422/.test(text)) {
				return { kind: "conflict", branch, message: /^[^\n]*/.exec(text)?.[0] ?? text }
			}

			throw error
		}
	},
}
