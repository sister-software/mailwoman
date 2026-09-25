import { errorMessage } from "@mailwoman/core/errors/schema"
import { runFile } from "@mailwoman/core/process"

/**
 * The GitHub org that owns our forks.
 */
export const FORK_ORG = "mailwoman"

/**
 * The upstream org every `whosonfirst-data-*` repo lives in.
 */
export const UPSTREAM_ORG = "whosonfirst-data"

/**
 * Describes the remote a WOF repo should be cloned from, with a `reason` a build log can print.
 */
export interface RepoOrigin {
	repo: string
	org: string
	url: string
	source: "fork" | "upstream"
	reason: string
}

/**
 * Returns the GitHub SSH remote URL for an org and repo, the form existing clones use.
 */
export function repoURL(org: string, repo: string): string {
	return `ssh://git@github.com/${org}/${repo}`
}

/**
 * Classifies our fork of a repo as absent, clean (nothing upstream lacks),
 * or diverged (holding at least one commit of ours).
 */
export type ForkState = "absent" | "clean" | "diverged"

/**
 * Reports the {@link ForkState} of a repo in an org, injected
 * so {@link resolveWOFRepoOrigin} can be tested without GitHub.
 */
export type ForkProbe = (org: string, repo: string) => Promise<ForkState>

/**
 * Resolves a WOF repo to our fork only when the fork has diverged, and to upstream otherwise.
 *
 * A clean fork resolves upstream because GitHub forks do not track their parent,
 * and a probe failure also resolves upstream with the failure recorded in `reason`.
 */
export async function resolveWOFRepoOrigin(repo: string, probe: ForkProbe): Promise<RepoOrigin> {
	let state: ForkState
	let probeFailure: string | undefined

	try {
		state = await probe(FORK_ORG, repo)
	} catch (error) {
		state = "absent"
		probeFailure = (error as Error).message
	}

	if (state === "diverged") {
		return {
			repo,
			org: FORK_ORG,
			url: repoURL(FORK_ORG, repo),
			source: "fork",
			reason: `${FORK_ORG}/${repo} carries commits upstream does not — our corrections ride this remote`,
		}
	}

	const reason = probeFailure
		? `fork lookup failed (${probeFailure}) — falling back to upstream, which is NOT evidence about the fork`
		: state === "clean"
			? `${FORK_ORG}/${repo} exists but carries nothing upstream lacks — upstream is the same content and stays current, ` +
				"while a fork does not track its parent"
			: `no ${FORK_ORG}/${repo} fork`

	return { repo, org: UPSTREAM_ORG, url: repoURL(UPSTREAM_ORG, repo), source: "upstream", reason }
}

/**
 * Probes our fork through the `gh` CLI, reporting `diverged` when GitHub's
 * compare shows the fork ahead of upstream.
 *
 * It returns `absent` only on a 404 and rethrows other lookup errors,
 * while a failed compare counts as `clean`.
 */
export const githubForkProbe: ForkProbe = async (org, repo) => {
	try {
		await runFile("gh", ["api", `/repos/${org}/${repo}`, "--jq", ".name"])
	} catch (error) {
		const stderr = error instanceof Error && "stderr" in error && typeof error.stderr === "string" ? error.stderr : ""

		if (/HTTP 404|Not Found/i.test(`${errorMessage(error)}${stderr}`)) {
			return "absent"
		}

		throw error
	}

	try {
		const { stdout } = await runFile("gh", [
			"api",
			`/repos/${org}/${repo}/compare/${UPSTREAM_ORG}:HEAD...${org}:HEAD`,
			"--jq",
			".ahead_by",
		])

		return Number(stdout.trim()) > 0 ? "diverged" : "clean"
	} catch {
		return "clean"
	}
}
