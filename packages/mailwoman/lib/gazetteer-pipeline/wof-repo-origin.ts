/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Which remote a WOF repo is pulled FROM — our fork when one exists, upstream otherwise.
 *
 *   We carry corrections upstream cannot merge on our schedule. The first is the January 2019 GB batch that deprecated
 *   `Rochester`, `Gillingham`, `Swansea`, `Telford` and 50 others with no successor (`gazetteer triage` reports the
 *   whole class): every one is a live settlement, and a geocoder that cannot name them is wrong today, whatever the
 *   upstream PR queue does. Forking is how a correction ships without waiting and without becoming a private patch
 *   nobody else can see — the fork is public, the diff is a normal WOF record change, and the upstream PR is a push
 *   away from the same branch.
 *
 *   The preference is DIVERGENCE-BASED, and must be: the fork org holds a fork of every `whosonfirst-data-*` repo,
 *   almost all of which carry nothing of ours. Existence therefore says only that a fork was made. Divergence says a
 *   correction lives there, which is the thing worth preferring a remote for. Nothing needs a second registration
 *   step, so the two lists cannot drift apart.
 *
 *   A machine with no network, no `gh`, or no fork resolves upstream and says so — the plain degradation, never a
 *   hard failure.
 *
 *   NOTHING here clones. It answers "where should this come from", so a clone, a fetch and an audit all read the same
 *   answer instead of three hand-typed URLs.
 */

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
 * Where a repo should be pulled from, and why — the `reason` travels so a build log can say which remote it read
 * without the reader inferring it from the URL.
 */
export interface RepoOrigin {
	repo: string
	org: string
	url: string
	source: "fork" | "upstream"
	reason: string
}

/**
 * SSH remote for an org/repo pair — the form the existing clones already use.
 */
export function repoURL(org: string, repo: string): string {
	return `ssh://git@github.com/${org}/${repo}`
}

/**
 * What our fork of a repo is, relative to upstream.
 *
 * `"absent"` — the fork org does not hold it. `"clean"` — a fork exists carrying nothing upstream lacks. `"diverged"` —
 * the fork holds at least one commit upstream does not, i.e. a correction of ours.
 */
export type ForkState = "absent" | "clean" | "diverged"

/**
 * What our fork looks like. Injected so the resolver stays pure and testable; the CLI passes a `gh`-backed probe, tests
 * pass a map.
 *
 * A boolean cannot express this: "a fork exists" and "the fork holds a correction" are different questions, and the
 * fork org answers yes to the first for every WOF repo.
 */
export type ForkProbe = (org: string, repo: string) => Promise<ForkState>

/**
 * Resolve the origin for one WOF repo.
 *
 * DIVERGENCE, NOT EXISTENCE. A GitHub fork does not track its parent, so a fork carrying none of our commits is a
 * point-in-time snapshot that drifts further from upstream every day it sits there. Preferring one would read older
 * data for no benefit, silently, on every fresh clone — which is why a CLEAN fork resolves upstream and says why.
 * "Prefer our fork" always meant "prefer the remote our corrections are on"; `diverged` is that, stated so a machine
 * can check it.
 *
 * A probe that THROWS (no network, no `gh`, no auth) resolves upstream with the failure in `reason`: an unreachable
 * fork registry is not evidence about the fork either way, and pretending otherwise would silently pull upstream data
 * over a correction we rely on. The caller sees which happened.
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
 * The `gh`-backed {@linkcode ForkProbe} the CLI passes — asks GitHub what our fork IS, not merely whether it exists.
 * `compare` answers `ahead_by` — commits the fork holds that upstream does not — and that is the only thing that makes
 * a fork worth preferring, since the fork org holds a fork of every WOF repo whether or not we have corrected it.
 *
 * A THROW is not "no fork": {@linkcode resolveWOFRepoOrigin} keeps that distinction, so a failed lookup is recorded as
 * upstream-with-a-caveat rather than upstream-as-established-fact.
 */
export const githubForkProbe: ForkProbe = async (org, repo) => {
	try {
		await runFile("gh", ["api", `/repos/${org}/${repo}`, "--jq", ".name"])
	} catch (error) {
		const stderr = error instanceof Error && "stderr" in error && typeof error.stderr === "string" ? error.stderr : ""

		// A 404 is a real answer: the fork does not exist. Anything else (no auth, no network, rate limit) is a
		// failed lookup, and must reach the resolver as a throw so it is not recorded as absence.
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
		// The fork is known to exist; only the comparison failed. Calling that "diverged" would prefer a
		// possibly-stale snapshot on no evidence.
		return "clean"
	}
}
