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
 *   The preference is deliberately EXISTENCE-BASED, not configured: a fork that exists is one we made on purpose, and
 *   requiring a second registration step is how the two lists drift. A machine with no network, no `gh`, or no fork
 *   resolves upstream and says so — the honest degradation, never a hard failure.
 *
 *   NOTHING here clones. It answers "where should this come from", so a clone, a fetch and an audit all read the same
 *   answer instead of three hand-typed URLs.
 */

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
 * Does the fork org hold this repo? Injected so the resolver stays pure and testable; the CLI passes a `gh`-backed
 * probe, tests pass a set.
 */
export type ForkProbe = (org: string, repo: string) => Promise<boolean>

/**
 * Resolve the origin for one WOF repo.
 *
 * A probe that THROWS (no network, no `gh`, no auth) resolves upstream with the failure in `reason`: an unreachable
 * fork registry is not evidence that no fork exists, and pretending otherwise would silently pull upstream data over a
 * correction we rely on. The caller sees which happened.
 */
export async function resolveWOFRepoOrigin(repo: string, probe: ForkProbe): Promise<RepoOrigin> {
	let forked: boolean
	let probeFailure: string | undefined

	try {
		forked = await probe(FORK_ORG, repo)
	} catch (error) {
		forked = false
		probeFailure = (error as Error).message
	}

	if (forked) {
		return {
			repo,
			org: FORK_ORG,
			url: repoURL(FORK_ORG, repo),
			source: "fork",
			reason: `${FORK_ORG}/${repo} exists — our corrections ride this remote`,
		}
	}

	return {
		repo,
		org: UPSTREAM_ORG,
		url: repoURL(UPSTREAM_ORG, repo),
		source: "upstream",
		reason: probeFailure
			? `fork lookup failed (${probeFailure}) — falling back to upstream, which is NOT evidence that no fork exists`
			: `no ${FORK_ORG}/${repo} fork`,
	}
}
