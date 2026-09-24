/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Select WOF repositories before network or filesystem changes. Pure helpers keep selection and refusals testable.
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
	 * GitHub's packed size in KB; checkout size may be much larger.
	 */
	diskUsageKB?: number
}

/**
 * Match WOF repository names, excluding the owner directory itself.
 */
const REPO_NAME_PATTERN = /^whosonfirst(?:-data)?-[a-z0-9-]+$/

/**
 * Reject a repository name used as the destination directory.
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
 * Map ISO-2 codes to admin and postalcode repositories.
 */
export function countryRepoNames(raw: string | undefined): string[] {
	return extractDelimited(raw).flatMap((code) => [wofRepoName("admin", code), wofRepoName("postalcode", code)])
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
 * Find the discovered name with the longest shared prefix.
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

	// Ignore the common prefix shared by every repository.
	return bestShared > "whosonfirst-data-".length ? best : null
}

function totalKB(entries: readonly DiscoveredRepo[]): number {
	return entries.reduce((sum, entry) => sum + (entry.diskUsageKB ?? 0), 0)
}

/**
 * Select discovered repositories or throw a descriptive error.
 */
export function selectRepos(discovered: readonly DiscoveredRepo[], options: SelectReposOptions): RepoSelection {
	const byName = new Map(discovered.map((entry) => [entry.name, entry]))
	const wanted = new Set<string>()

	// Reject unknown names instead of silently syncing an empty selection.
	for (const name of extractDelimited(options.repos)) {
		if (!byName.has(name)) {
			const suggestion = nearestName(name, discovered)

			// A country-name hint is more reliable than a near-spelling suggestion.
			throw new CommandError(
				`No repository named \`${name}\` in ${WOF_REPO_OWNER}.` +
					(suggestion ? ` Did you mean \`${suggestion}\`?` : "") +
					`\n  For a whole country, pass an ISO-2 code instead: --countries <cc>`
			)
		}

		wanted.add(name)
	}

	// Include available admin and postalcode repositories; either may be absent.
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

	// Preserve GitHub's discovered order for stable plans.
	const selected = discovered.filter((entry) => wanted.has(entry.name))

	return { selected, totalDiskUsageKB: totalKB(selected) }
}
