/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Selects WOF repositories for a sync before any network or filesystem work. The helpers are pure so
 *   tests can cover selection and rejection directly.
 */

import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { WOF_DATA_OWNER, wofRepoName } from "@mailwoman/core/resources/whosonfirst"
import { extractDelimited } from "@mailwoman/core/scripting/arguments"
import { CommandError } from "@mailwoman/core/scripting/command"

/**
 * GitHub owner of the country data repositories.
 */
export const WOF_REPO_OWNER = WOF_DATA_OWNER

/**
 * Repository details returned by `gh repo list`.
 */
export interface DiscoveredRepo {
	name: string
	url: string
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
 * Throws when the destination directory's basename is a WOF repository name,
 * which usually means the user meant `--repos`.
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
export function countryRepoNames(raw: string | undefined): string[] {
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
 * Selects discovered repositories by name, country or `all`, and throws a descriptive
 * error for an unknown name, an unknown country or a missing filter.
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

	if (!wanted.size) {
		if (!options.all) {
			throw new CommandError(
				`No --repos or --countries filter. Syncing all of ${WOF_REPO_OWNER} means ` +
					`${discovered.length} repositories, ${ByteFormatter.formatSI(totalKB(discovered) * 1024)} as GitHub ` +
					`reports them — several times that once checked out. Pass --all to confirm, or narrow the sync.`
			)
		}

		return { selected: [...discovered], totalDiskUsageKB: totalKB(discovered) }
	}

	// The selection keeps discovery order so that plans are stable.
	const selected = discovered.filter((entry) => wanted.has(entry.name))

	return { selected, totalDiskUsageKB: totalKB(selected) }
}
