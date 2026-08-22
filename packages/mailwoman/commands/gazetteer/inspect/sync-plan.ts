/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Which repositories a sync will clone, decided before any network or disk work happens.
 *
 *   Split out of the command so the decisions are testable without Ink: every refusal here is one a caller should meet
 *   as a message rather than as a directory full of unwanted clones.
 */

import { WOF_DATA_OWNER, wofRepoName } from "@mailwoman/core/resources/whosonfirst"
import { CommandError } from "@mailwoman/core/scripting/command"

/**
 * The GitHub organization holding the country data repositories.
 */
export const WOF_REPO_OWNER = WOF_DATA_OWNER

/**
 * A repository as `gh repo list` reports it.
 */
export interface DiscoveredRepo {
	name: string
	url: string
	/**
	 * GitHub's reported size. It UNDER-states the checkout by roughly 7×: GitHub reports the packed size, and these repos
	 * unpack to millions of small GeoJSON files. Measured on a `--countries tr` sync: three repositories reported as 83.4
	 * MB occupied 633 MB once cloned.
	 */
	diskUsageKB?: number
}

/**
 * A repository NAME, as opposed to a path that happens to contain one.
 *
 * `whosonfirst-data` alone is excluded: that is the owner directory this command writes into, not a repository.
 */
const REPO_NAME_PATTERN = /^whosonfirst(?:-data)?-[a-z0-9-]+$/

function splitList(raw: string | undefined): string[] {
	if (!raw) return []

	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
}

/**
 * Refuse a destination that is really a repository name.
 *
 * The destination is a directory, so a repository name in that slot is accepted by every check the filesystem can make:
 * the directory is created, no `--repos` filter is applied, and the whole organization syncs into it.
 */
export function assertDestinationNotARepoName(destination: string): void {
	const basename = destination.trim().replace(/\/+$/, "").split("/").pop() ?? ""

	if (!REPO_NAME_PATTERN.test(basename)) return

	throw new CommandError(
		`\`${basename}\` is a repository name, not the destination directory.\n` +
			`  Did you mean:  --repos ${basename}\n` +
			`  Destination:   sync <dir> --repos <name>, or omit <dir> for the data root`
	)
}

/**
 * Expand ISO-2 country codes to the repositories a country build reads.
 *
 * Venue repositories are deliberately absent: no country in the data root has one cloned, and including them would
 * roughly double the transfer for data no build on the parse path consumes.
 */
export function countryRepoNames(raw: string | undefined): string[] {
	return splitList(raw).flatMap((code) => [wofRepoName("admin", code), wofRepoName("postalcode", code)])
}

export interface SelectReposOptions {
	/**
	 * Comma-separated repository allow-list.
	 */
	repos?: string
	/**
	 * Comma-separated ISO-2 country codes.
	 */
	countries?: string
	/**
	 * Sync every repository in the organization.
	 */
	all?: boolean
}

export interface RepoSelection {
	selected: DiscoveredRepo[]
	totalDiskUsageKB: number
}

/**
 * The closest discovered name, by shared prefix.
 *
 * A prefix comparison is enough because these names are structured — `whosonfirst-data-<theme>-<cc>` — so a typo
 * diverges at a known position and the correct name is the one that agrees for longest. An edit-distance comparator
 * exists in `@mailwoman/match`, but this is the only caller in the package and would be its only reason to depend on
 * it.
 */
function nearestName(candidate: string, discovered: readonly DiscoveredRepo[]): string | null {
	let best: string | null = null
	let bestShared = 0

	for (const entry of discovered) {
		let shared = 0

		while (shared < candidate.length && shared < entry.name.length && candidate[shared] === entry.name[shared]) {
			shared++
		}

		if (shared > bestShared) {
			bestShared = shared
			best = entry.name
		}
	}

	// Every repository in the org shares `whosonfirst-`, so a match no longer than that carries no information.
	return bestShared > "whosonfirst-data-".length ? best : null
}

function totalKB(entries: readonly DiscoveredRepo[]): number {
	return entries.reduce((sum, entry) => sum + (entry.diskUsageKB ?? 0), 0)
}

/**
 * Decide which discovered repositories to sync, or refuse with the reason.
 */
export function selectRepos(discovered: readonly DiscoveredRepo[], options: SelectReposOptions): RepoSelection {
	const byName = new Map(discovered.map((entry) => [entry.name, entry]))
	const wanted = new Set<string>()

	// An explicitly named repository must exist. Before this check an unmatched name filtered the list to nothing and
	// the command reported a successful sync of the placetypes repo alone, so a typo read as a completed job.
	for (const name of splitList(options.repos)) {
		if (!byName.has(name)) {
			const suggestion = nearestName(name, discovered)

			// The near miss is a string comparison and cannot recover intent: `whosonfirst-data-admin-turkey` is nearer
			// to `-tu` than to `-tr` by any metric. So the country hint is unconditional — a caller who wrote a country
			// name in a repository slot is the case this refusal exists for.
			throw new CommandError(
				`No repository named \`${name}\` in ${WOF_REPO_OWNER}.` +
					(suggestion ? ` Did you mean \`${suggestion}\`?` : "") +
					`\n  For a whole country, pass an ISO-2 code instead: --countries <cc>`
			)
		}

		wanted.add(name)
	}

	// A country expands to the repositories it MIGHT have; only a country with none at all is an error. Most countries
	// carry an admin repository and no postalcode one, so requiring both would refuse the common case.
	for (const code of splitList(options.countries)) {
		const candidates = countryRepoNames(code).filter((name) => byName.has(name))

		if (!candidates.length) {
			throw new CommandError(
				`No admin or postalcode repository for \`${code}\` in ${WOF_REPO_OWNER}. ` +
					`Expected one of ${countryRepoNames(code).join(", ")}.`
			)
		}

		for (const name of candidates) {
			wanted.add(name)
		}
	}

	if (!wanted.size) {
		if (!options.all) {
			throw new CommandError(
				`No --repos or --countries filter. Syncing all of ${WOF_REPO_OWNER} means ` +
					`${discovered.length} repositories, ${(totalKB(discovered) / 1024 / 1024).toFixed(1)} GB as GitHub ` +
					`reports them — several times that once checked out. Pass --all to confirm, or narrow the sync.`
			)
		}

		return { selected: [...discovered], totalDiskUsageKB: totalKB(discovered) }
	}

	// Discovered order, so a plan reads the same way twice.
	const selected = discovered.filter((entry) => wanted.has(entry.name))

	return { selected, totalDiskUsageKB: totalKB(selected) }
}
