/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer inspect sync` — clone or pull the Who's On First country repositories that the gazetteer
 *   builds read.
 *
 *   The destination defaults to `<data-root>/wof/repos`, matching every consumer of these repositories
 *   (`gazetteer build admin`, `gazetteer build`, `build postcode-database`, `gazetteer polygons` all document that same
 *   default). Which repositories to sync is decided in `sync-plan.ts` before any network work, so a mistake is a
 *   message rather than a directory full of clones.
 *
 *   The progress display reports REPOSITORIES, and the per-repository `▸` lines are the required part: a first
 *   clone of a large country runs for minutes, and a counter that moves only on completion is indistinguishable from a
 *   hang while it does. Those lines go to stderr, so they survive the non-interactive Ink render that writes one frame
 *   at unmount.
 */

import { ProgressBar } from "@inkjs/ui"
import type { RepositorySource, SynchronizeAction } from "@mailwoman/core"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { formatQuantity } from "@mailwoman/core/resources/locale"
import { dataRootPath } from "@mailwoman/core/utils"
import { Box, Text } from "ink"
import { PathBuilder } from "path-ts"
import { useState } from "react"

import {
	type Check,
	CheckList,
	CommandError,
	type CommandSpec,
	CommandTaskResult,
	type ParsedCommandComponent,
	useCommandTask,
} from "#cli-kit"
import {
	assertDestinationNotARepoName,
	selectRepos,
	WOF_REPO_OWNER,
	type DiscoveredRepo,
	type RepoSelection,
} from "#commands/gazetteer/inspect/sync-plan"

/**
 * Concurrency for the clone fan-out.
 *
 * Fixed rather than `availableParallelism()`: these are network transfers of hundreds of megabytes, so the ceiling is
 * bandwidth and GitHub's patience, not cores. A 128-core host opening 128 clones serves nobody.
 */
const CONCURRENCY = 8

/**
 * Above this many repositories the final list is summarized instead of printed in full. The `▸` lines above it are
 * complete either way — this bounds the closing frame, not the record.
 */
const MAX_LISTED_CHECKS = 25

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "sync",
	description: "Synchronize Who's On First repositories.",
	positionals: [
		{
			name: "local-repo-directory",
			description: "Repository root. Default <data-root>/wof/repos",
		},
	],
	options: {
		repos: { type: "string", description: "Comma-separated repository allow-list" },
		countries: { type: "string", description: "Comma-separated ISO-2 countries (admin + postalcode repositories)" },
		all: { type: "boolean", default: false, description: `Sync every repository in ${WOF_REPO_OWNER}` },
		"dry-run": { type: "boolean", default: false, description: "Print the plan without cloning" },
	},
} as const satisfies CommandSpec

interface Options {
	repos?: string
	countries?: string
	all?: boolean
	dryRun?: boolean
}

interface SyncPlan {
	destination: string
	selection: RepoSelection
	sourceCount: number
}

/**
 * Ask GitHub what the organization holds.
 *
 * `gh` is a hard requirement and its absence is reported as such: without this the failure surfaces as an opaque spawn
 * error from deep inside the task.
 */
async function discoverRepos(): Promise<DiscoveredRepo[]> {
	const { $ } = await import("zx")

	try {
		return $.sync`gh repo list ${WOF_REPO_OWNER} --no-archived --limit 1000 --json name --json url --json diskUsage`
			.json<Array<{ name: string; url: string; diskUsage: number }>>()
			.map(({ name, url, diskUsage }) => ({ name, url, diskUsageKB: diskUsage }))
	} catch (error) {
		throw new CommandError(
			`Could not list ${WOF_REPO_OWNER} through \`gh\`. Install the GitHub CLI and run \`gh auth login\`.`,
			{ cause: error }
		)
	}
}

const WOFSync: ParsedCommandComponent<Options, [string?]> = ({ options, args }) => {
	const [plan, setPlan] = useState<SyncPlan>()
	const [active, setActive] = useState<readonly string[]>([])
	const [doneCount, setDoneCount] = useState(0)

	const state = useCommandTask(
		async () => {
			const requested = args[0]

			if (requested) {
				assertDestinationNotARepoName(requested)
			}

			const destination = PathBuilder.from(requested ?? dataRootPath("wof", "repos"))

			const { Placetype, PLACETYPES_REPO_SOURCE, synchronizeRepo } = await import("@mailwoman/core")
			const { parallelMap } = await import("spliterator")

			const selection = selectRepos(await discoverRepos(), {
				repos: options.repos,
				countries: options.countries,
				all: options.all,
			})

			// WHERE each repo comes from is resolved per repo, not assumed to be upstream. `gh repo list` enumerates the
			// UPSTREAM org, so the discovered `url` always names upstream — cloning from it would pull upstream data over
			// the corrections our fork carries (the January 2019 GB deprecation batch is the first, #1742). Existing
			// clones are NOT re-pointed here: `synchronizeRepo` pulls in place and never rewrites a remote, so this fixes
			// new clones only. `gazetteer repos-sync` reports and re-points the existing ones.
			const { githubForkProbe, resolveWOFRepoOrigin } = await import("#gazetteer/wof-repo-origin")

			const resolved = await Promise.all(
				selection.selected.map(async ({ name }) => {
					const origin = await resolveWOFRepoOrigin(name, githubForkProbe)

					if (origin.source === "fork") {
						console.error(`▸ ${name}: ${origin.reason}`)
					} else if (origin.reason.includes("fork lookup failed")) {
						console.error(`▸ ${name}: ${origin.reason}`)
					}

					// `owner` is the DIRECTORY, and it stays upstream even when the bytes come from our fork. The
					// destination is `<root>/<owner>/<name>`, so keying it on the resolved org would give one repo two
					// homes — and `ingestWOF` globs the whole root, so the build would read both and resolve the conflict
					// by FastGlob enumeration order (`repos-audit.ts` documents that hazard). One repo, one directory,
					// whichever remote filled it.
					return { name, url: origin.url, owner: WOF_REPO_OWNER }
				})
			)

			// The placetypes codex is not optional: `Placetype.prepare` below reads it, and every consumer of a
			// synchronized tree resolves placetypes through it.
			const sources: RepositorySource[] = [...resolved, PLACETYPES_REPO_SOURCE]

			setPlan({ destination: destination.toString(), selection, sourceCount: sources.length })

			console.error(
				`▸ sync ${formatQuantity(sources.length)} repositories ` +
					`(${ByteFormatter.formatSI(selection.totalDiskUsageKB * 1024)} as GitHub reports them) → ${destination}` +
					(options.dryRun ? " (dry-run)" : "")
			)

			if (options.dryRun) {
				return {
					ok: true,
					checks: sources.map((source) => ({
						ok: true,
						check: source.name,
						detail: `[dry-run] ${source.url} → ${destination}/${source.owner}/${source.name}`,
					})),
				}
			}

			const checks: Check[] = []
			let ok = true

			const batchIterator = parallelMap(
				sources,
				async (source) => {
					const startedAt = performance.now()

					setActive((current) => [...current, source.name])

					console.error(`▸ ${source.name}`)

					let action: SynchronizeAction | null = null
					let failure: string | null = null

					try {
						action = await synchronizeRepo(source, destination)
					} catch (error) {
						ok = false
						failure = error instanceof Error ? error.message : String(error)
					}

					const elapsed = `${((performance.now() - startedAt) / 1000).toFixed(1)}s`

					setActive((current) => current.filter((name) => name !== source.name))
					setDoneCount((count) => count + 1)

					console.error(`${failure ? "✗" : "✓"} ${source.name} ${failure ?? action} ${elapsed}`)

					checks.push({
						ok: !failure,
						check: source.name,
						detail: failure ?? `${action} in ${elapsed}`,
					})
				},
				{ concurrency: CONCURRENCY }
			)

			await Array.fromAsync(batchIterator)

			await Placetype.prepare({ batchSize: CONCURRENCY, localRepoDirectory: destination })

			if (checks.length > MAX_LISTED_CHECKS) {
				const failed = checks.filter((check) => !check.ok)

				return {
					ok,
					checks: [
						{
							ok,
							check: `${formatQuantity(checks.length)} repositories`,
							detail: `${formatQuantity(checks.length - failed.length)} synchronized, ${formatQuantity(failed.length)} failed — see the lines above for each`,
						},
						...failed,
					],
				}
			}

			return { ok, checks }
		},
		(result) => (result.ok ? 0 : 1)
	)

	if (state.status === "error") return <CommandTaskResult state={state} />

	if (state.status === "done") return <CheckList checks={state.result.checks} verdict={state.result.ok} />

	if (!plan) return <Text color="gray">Listing {WOF_REPO_OWNER}…</Text>

	const percentage = (doneCount / plan.sourceCount) * 100

	return (
		<Box flexDirection="column">
			<Text color="gray">
				{plan.destination} — {formatQuantity(plan.sourceCount)} repositories,{" "}
				{ByteFormatter.formatSI(plan.selection.totalDiskUsageKB * 1024)}
			</Text>

			{active.map((name) => (
				<Text key={name} color="cyan">
					{" "}
					⠋ {name}
				</Text>
			))}

			<Box paddingX={1}>
				<ProgressBar value={percentage} />
				<Text>
					{" "}
					{formatQuantity(doneCount)} of {formatQuantity(plan.sourceCount)} repositories
				</Text>
			</Box>
		</Box>
	)
}

export default WOFSync
