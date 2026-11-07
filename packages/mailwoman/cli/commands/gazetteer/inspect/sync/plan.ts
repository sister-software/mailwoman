/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Selects WOF repositories for a sync before any network or filesystem work. The helpers are pure so
 *   tests can cover selection and rejection directly.
 */

import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { extractDelimited } from "@mailwoman/core/scripting/arguments"
import { CommandError } from "@mailwoman/core/scripting/command"
import { WOF_DATA_OWNER, wofRepoName } from "@mailwoman/gazetteer/whosonfirst"

/**
 * GitHub owner of the country data repositories.
 */
export const WOF_REPO_OWNER = WOF_DATA_OWNER

/**
 * Repository details returned by `gh repo list` for the upstream organization.
 */
export interface DiscoveredRepo {
	name: string
	/**
	 * GitHub's packed repository size in KB.
	 * A checkout can be much larger.
	 */
	diskUsageKB?: number
}

/**
 * Matches WOF repository names.
 */
const REPO_NAME_PATTERN = /^whosonfirst(?:-data)?-[a-z0-9-]+$/

/**
 * Throws when the destination directory's basename is a WOF repository name.
 * In that case, the user likely meant `--repos`.
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
 * Maps comma-separated ISO 3166-1 alpha-2 codes to their admin and postalcode repository names.
 */
export function countryRepoNames(raw: string | null): string[] {
	return extractDelimited(raw).flatMap((code) => [wofRepoName("admin", code), wofRepoName("postalcode", code)])
}

/**
 * Filters for {@link selectRepos}.
 */
export interface SelectReposOptions {
	/**
	 * Comma-separated repository names.
	 */
	repos?: string
	/**
	 * Comma-separated ISO 3166-1 alpha-2 country codes.
	 */
	countries?: string
	/**
	 * Selects every repository when no other filter is set.
	 */
	all?: boolean
	/**
	 * Names of the repositories already cloned under the root.
	 *
	 * Every one is selected, so a sync with no filter refreshes the clones that exist.
	 */
	cloned?: readonly string[]
}

/**
 * The selected repositories and their combined packed size.
 */
export interface RepoSelection {
	selected: DiscoveredRepo[]
	totalDiskUsageKB: number
}

/**
 * Returns the discovered name with the longest shared prefix, or `null` when no name
 * shares more than the common `whosonfirst-data-` prefix.
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

	return bestShared > "whosonfirst-data-".length ? best : null
}

function totalKB(entries: readonly DiscoveredRepo[]): number {
	return entries.reduce((sum, entry) => sum + (entry.diskUsageKB ?? 0), 0)
}

/**
 * Selects the repositories already cloned, plus discovered repositories by name, country or `all`.
 *
 * A cloned repository missing from the discovery, such as one upstream archived,
 * is still selected, so its clone keeps being refreshed from its fork.
 * It throws a descriptive error for an unknown name, an unknown country,
 * or a sync with no filter and no clones.
 */
export function selectRepos(discovered: readonly DiscoveredRepo[], options: SelectReposOptions): RepoSelection {
	const byName = new Map(discovered.map((entry) => [entry.name, entry]))
	const wanted = new Set<string>()

	for (const name of extractDelimited(options.repos)) {
		if (!byName.has(name)) {
			const suggestion = nearestName(name, discovered)

			throw new CommandError(
				`No repository named \`${name}\` in ${WOF_REPO_OWNER}.` +
					(suggestion ? ` Did you mean \`${suggestion}\`?` : "") +
					`\n  For a whole country, pass an ISO-2 code instead: --countries <cc>`
			)
		}

		wanted.add(name)
	}

	// A country may lack its admin or its postalcode repository.
	// It fails only when both are missing.
	for (const code of extractDelimited(options.countries)) {
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

	const cloned = options.cloned ?? []

	if (!wanted.size && !options.all && !cloned.length) {
		throw new CommandError(
			`Nothing is cloned yet, and there is no --repos or --countries filter. Syncing all of ${WOF_REPO_OWNER} means ` +
				`${discovered.length} repositories, ${ByteFormatter.formatSI(totalKB(discovered) * 1024)} as GitHub ` +
				`reports them — several times that once checked out. Pass --all to confirm, or narrow the sync.`
		)
	}

	// The selection keeps discovery order so that plans are stable, then appends clones discovery did not list.
	const named = options.all
		? [...discovered]
		: discovered.filter((entry) => wanted.has(entry.name) || cloned.includes(entry.name))

	const listed = new Set(named.map((entry) => entry.name))
	const selected = [...named, ...cloned.filter((name) => !listed.has(name)).map((name) => ({ name }))]

	return { selected, totalDiskUsageKB: totalKB(selected) }
}
