

import { errorMessage } from "@mailwoman/core/errors/schema"
import { runFile } from "@mailwoman/core/process"


export const FORK_ORG = "mailwoman"


export const UPSTREAM_ORG = "whosonfirst-data"


export interface RepoOrigin {
	repo: string
	org: string
	url: string
	source: "fork" | "upstream"
	reason: string
}


export function repoURL(org: string, repo: string): string {
	return `ssh://git@github.com/${org}/${repo}`
}


export type ForkState = "absent" | "clean" | "diverged"


export type ForkProbe = (org: string, repo: string) => Promise<ForkState>


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
