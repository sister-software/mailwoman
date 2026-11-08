// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `mailwoman gazetteer inspect sync` — clone or refresh the Who's On First repositories that the gazetteer builds
 *   read, every one from its `mailwoman` fork, directly under the repos root.
 *
 *   The destination defaults to `<data-root>/src/wof-repos`, matching every consumer of these repositories
 *   (`gazetteer build admin`, `gazetteer build`, `build postcode-database`, `gazetteer polygons` all document that same
 *   default). The repositories already cloned there are always refreshed; `--repos`, `--countries` and `--all` add more.
 *   Which repositories to sync is decided in `plan.ts` before any network work, so a mistake is a message rather than
 *   a directory full of clones. `syncWOFRepo` in `@mailwoman/gazetteer` does the per-repository work.
 *
 *   The progress display reports repositories. Per-repository `▸` lines are required because a first
 *   clone of a large country runs for minutes. A counter that moves only on completion looks like a
 *   hang during that time. The lines go to stderr, so they survive the non-interactive Ink render that writes one frame
 *   at unmount.
 */

import { ProgressBar } from "@inkjs/ui"
import { wofReposPath } from "@mailwoman/core/data-root"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { GitClient } from "@mailwoman/core/git"
import { parseJSONStrict } from "@mailwoman/core/json"
import { runFile } from "@mailwoman/core/process"
import { formatQuantity } from "@mailwoman/core/resources/locale"
import { CommandError } from "@mailwoman/core/scripting/command"
import type { RepoSyncResult } from "@mailwoman/gazetteer/tools/pipeline/repos/sync"
import { Box, Text } from "ink"
import { PathBuilder } from "path-ts"
import { useState } from "react"

import {
	type Check,
	CheckList,
	type CommandSpec,
	CommandTaskResult,
	type CommandComponent,
	ProgressLines,
	useCommandTask,
	useProgressFeed,
} from "#cli-kit"
import {
	assertDestinationNotARepoName,
	selectRepos,
	WOF_REPO_OWNER,
	type DiscoveredRepo,
	type RepoSelection,
} from "#cli/commands/gazetteer/inspect/sync/plan"

/**
 * Concurrency for the sync fan-out.
 *
 * Fixed rather than `availableParallelism()`: these are network transfers of hundreds of
 * megabytes, so the ceiling is bandwidth and GitHub's patience rather than cores.
 * A 128-core host opening 128 clones leaves no capacity for other requests.
 */
const CONCURRENCY = 8

/**
 * Above this repository count the final list is summarized instead of printed in full.
 *
 * The `▸` lines above it are complete either way.
 * This bounds the closing frame rather than the record.
 */
const MAX_LISTED_CHECKS = 25

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "sync",
	description: "Clone or refresh Who's On First repositories from the mailwoman forks.",
	positionals: [
		{
			name: "local-repo-directory",
			description: "Repository root. Default <data-root>/src/wof-repos",
		},
	],
	options: {
		repos: { type: "string", description: "Comma-separated repositories to add to the clones that exist" },
		countries: { type: "string", description: "Comma-separated ISO-2 countries to add (admin + postalcode)" },
		all: { type: "boolean", default: false, description: `Sync every repository in ${WOF_REPO_OWNER}` },
		"dry-run": {
			type: "boolean",
			default: false,
			description:
				"Report what each repository needs, measured against its fork, without a GitHub request or a change to any clone",
		},
	},
} as const satisfies CommandSpec

interface SyncPlan {
	destination: string
	selection: RepoSelection
	count: number
}

/**
 * Ask GitHub what the upstream organization holds.
 *
 * `gh` is a hard requirement and its absence is reported as such: without this the
 * failure surfaces as an opaque spawn error from deep inside the task.
 */
async function discoverRepos(): Promise<DiscoveredRepo[]> {
	try {
		const { stdout } = await runFile("gh", [
			"repo",
			"list",
			WOF_REPO_OWNER,
			"--no-archived",
			"--limit",
			"1000",
			"--json",
			"name,diskUsage",
		])

		return parseJSONStrict<Array<{ name: string; diskUsage: number }>>(stdout).map(({ name, diskUsage }) => ({
			name,
			diskUsageKB: diskUsage,
		}))
	} catch (error) {
		throw new CommandError(
			`Could not list ${WOF_REPO_OWNER} through \`gh\`. Install the GitHub CLI and run \`gh auth login\`.`,
			{ cause: error }
		)
	}
}

/**
 * The sentence for one repository's line in the closing list.
 */
function describeResult(result: RepoSyncResult): string {
	const parts = [result.reason]

	if (result.forkCreated) {
		parts.push("fork created")
	}

	const update = result.forkUpdate

	if (update?.kind === "conflict") {
		parts.push(`fork conflicts with upstream: ${update.message}`)
	} else if (update && update.kind !== "none") {
		parts.push(`fork ${update.kind} from upstream`)
	}

	const { compacted } = result

	if (compacted) {
		parts.push(
			`re-shallowed from ${compacted.commitsBefore} to ${compacted.commitsAfter} commit(s)` +
				(compacted.otherBranches.length ? `; local branches keep history: ${compacted.otherBranches.join(", ")}` : "")
		)
	}

	for (const change of result.remoteChanges) {
		parts.push(
			`${result.dryRun ? "would " : ""}${change.kind === "remove" ? "remove" : change.kind} remote ${change.remote}`
		)
	}

	return parts.join("; ")
}

const WOFSync: CommandComponent<typeof spec, [string?]> = ({ options, args }) => {
	const [plan, setPlan] = useState<SyncPlan>()
	const [active, setActive] = useState<readonly string[]>([])
	const [doneCount, setDoneCount] = useState(0)
	const progress = useProgressFeed()

	const state = useCommandTask(
		async () => {
			const requested = args[0]

			if (requested) {
				assertDestinationNotARepoName(requested)
			}

			const destination = PathBuilder.from(requested ?? wofReposPath())
			const dryRun = options.dryRun

			const [
				{ Placetype, PLACETYPES_REPO },
				{ auditReposRoot },
				{ sameRemote, syncSentence, syncWOFRepo },
				{ githubForkHost },
			] = await Promise.all([
				import("@mailwoman/gazetteer"),
				import("@mailwoman/gazetteer/tools/pipeline/repos/audit"),
				import("@mailwoman/gazetteer/tools/pipeline/repos/sync"),
				import("@mailwoman/gazetteer/tools/pipeline/wof/repo-origin"),
			])

			const { wofDatabasePath } = await import("@mailwoman/resolver-wof-sqlite/paths")
			const { parallelMap } = await import("spliterator")

			const audit = await auditReposRoot(destination, { readCommits: false })

			for (const stray of audit.strays) {
				console.error(`▸ ${destination}/${stray} is not a repository clone; the admin ingest reads its GeoJSON too`)
			}

			for (const link of audit.links) {
				console.error(`▸ ${destination}/${link} is a symbolic link; the sync leaves it alone and the ingest skips it`)
			}

			const selection = selectRepos(await discoverRepos(), {
				repos: options.repos,
				countries: options.countries,
				all: options.all,
				cloned: audit.repos.map((repo) => repo.name),
			})

			// `Placetype.prepare` reads the placetypes repository below, so every sync includes it.
			const names = [...new Set([...selection.selected.map((entry) => entry.name), PLACETYPES_REPO.name])]

			setPlan({ destination: destination.toString(), selection, count: names.length })

			console.error(
				`▸ sync ${formatQuantity(names.length)} repositories ` +
					`(${ByteFormatter.formatSI(selection.totalDiskUsageKB * 1024)} as GitHub reports them) → ${destination}` +
					(dryRun ? " (dry-run)" : "")
			)

			const results: RepoSyncResult[] = []
			const checks: Check[] = []
			let ok = true

			const batchIterator = parallelMap(
				names,
				async (name) => {
					const startedAt = performance.now()

					setActive((current) => [...current, name])

					console.error(`▸ ${name}`)

					await using client = new GitClient({ cwd: destination })

					const unwatch = progress.watch(client, name)

					let detail: string
					let passed: boolean

					try {
						const result = await syncWOFRepo(name, { root: destination, host: githubForkHost, client, dryRun })

						results.push(result)
						detail = describeResult(result)
						passed = !result.action.startsWith("refuse") && result.forkUpdate?.kind !== "conflict"
					} catch (error) {
						detail = error instanceof Error ? error.message : String(error)
						passed = false
					} finally {
						unwatch()
						progress.clear(name)
					}

					ok &&= passed

					const elapsed = `${((performance.now() - startedAt) / 1000).toFixed(1)}s`

					setActive((current) => current.filter((entry) => entry !== name))
					setDoneCount((count) => count + 1)

					console.error(`${passed ? "✓" : "✗"} ${name} ${detail} ${elapsed}`)

					checks.push({ ok: passed, check: name, detail: `${detail} (${elapsed})` })
				},
				{ concurrency: CONCURRENCY }
			)

			await Array.fromAsync(batchIterator)

			console.error(`▸ ${syncSentence(results)}`)

			if (!dryRun) {
				await Placetype.prepare({ batchSize: CONCURRENCY, localRepoDirectory: destination })

				// The vintage stamp lives outside the repos root because `ingestWOF` globs that root.
				const vintagePath = wofDatabasePath("repos-vintage.json")

				await makeDirectories(vintagePath.dirname())

				await writeLocalJSONFile(
					{
						root: destination.toString(),
						repos: results
							.toSorted((a, b) => a.repo.localeCompare(b.repo))
							.map((result) => ({
								repo: result.repo,
								originURL: result.state.remotes["origin"] ?? null,
								onFork: sameRemote(result.state.remotes["origin"], result.origin.forkURL),
								head: result.state.head,
								headDate: result.state.headDate,
								shallow: result.state.shallow,
								action: result.action,
							})),
					},
					vintagePath
				)

				console.error(`▸ vintage → ${vintagePath}`)
			}

			if (checks.length > MAX_LISTED_CHECKS) {
				const failed = checks.filter((check) => !check.ok)

				return {
					ok,
					checks: [
						{
							ok,
							check: `${formatQuantity(checks.length)} repositories`,
							detail: `${formatQuantity(checks.length - failed.length)} synchronized, ${formatQuantity(failed.length)} failed or refused — see the lines above for each`,
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

	const percentage = (doneCount / plan.count) * 100

	return (
		<Box flexDirection="column">
			<Text color="gray">
				{plan.destination} — {formatQuantity(plan.count)} repositories,{" "}
				{ByteFormatter.formatSI(plan.selection.totalDiskUsageKB * 1024)}
			</Text>

			{active
				.filter((name) => !progress.entries.has(name))
				.map((name) => (
					<Text key={name} color="cyan">
						{" "}
						⠋ {name}
					</Text>
				))}

			<ProgressLines entries={progress.entries} />

			<Box paddingX={1}>
				<ProgressBar value={percentage} />
				<Text>
					{" "}
					{formatQuantity(doneCount)} of {formatQuantity(plan.count)} repositories
				</Text>
			</Box>
		</Box>
	)
}

export default WOFSync
