/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { availableParallelism } from "node:os"

import { ProgressBar } from "@inkjs/ui"
import type { RepositorySource } from "@mailwoman/core"
import { formatQuantity } from "@mailwoman/core/resources/locale"
import { Box, Text } from "ink"
import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "mailwoman/cli-kit"
import { PathBuilder } from "path-ts"
import { useMemo, useState } from "react"

const BATCH_SIZE = availableParallelism()
const WOF_REPO_OWNER = "whosonfirst-data"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "sync",
	description: "Synchronize Who's On First repositories.",
	positionals: [{ name: "local-repo-directory", required: true, description: "Repository root" }],
	options: { repos: { type: "string", description: "Comma-separated repository allow-list" } },
} as const satisfies CommandSpec

/**
 * `--repos` is a comma-separated allow-list of repo names. When set, the discovery step still queries `gh repo list`
 * for `whosonfirst-data/*` but filters down to only repos whose `name` is present in the list. When absent, every
 * non-archived repo in the org is synced (the original behavior).
 *
 * The corpus build only needs a small subset (4 repos for US+FR admin+postalcode + the placetypes codex). Cloning all
 * ~100 whosonfirst-data repos is otherwise ~2.9 GB of git for no reason.
 */
interface Options {
	repos?: string
}

function parseReposFilter(raw: string | undefined): Set<string> | undefined {
	if (!raw) return undefined

	const allow = new Set(
		raw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)
	)

	return allow.size ? allow : undefined
}

const WOFSync: ParsedCommandComponent<Options, [string]> = ({ options, args }) => {
	const [repos, setRepos] = useState<RepositorySource[]>()
	const localRepoDirectory = useMemo(() => PathBuilder.from(args[0]!), [args])
	const [syncCount, setSyncCount] = useState(0)
	const percentage = Array.isArray(repos) ? (syncCount / repos.length) * 100 : 0

	const allow = useMemo(() => parseReposFilter(options.repos), [options.repos])

	const state = useCommandTask(async () => {
		const { Placetype, PLACETYPES_REPO_SOURCE, synchronizeRepo } = await import("@mailwoman/core")
		const { parallelMap } = await import("spliterator")
		const { $ } = await import("zx")

		const discovered = $.sync`gh repo list ${WOF_REPO_OWNER} --no-archived --limit 1000 --json 'name' --json 'url'`
			.json<Omit<RepositorySource, "owner">[]>()
			.map((entry): RepositorySource => ({ ...entry, owner: WOF_REPO_OWNER }))

		const filtered = allow ? discovered.filter((entry) => allow.has(entry.name)) : discovered
		const sources = [...filtered, PLACETYPES_REPO_SOURCE]
		setRepos(sources)

		const abortController = new AbortController()

		const batchIterator = parallelMap(
			sources,
			async (entry) => {
				await synchronizeRepo(entry, localRepoDirectory)

				setSyncCount((count) => count + 1)
			},
			{ concurrency: BATCH_SIZE, signal: abortController.signal }
		)

		await Array.fromAsync(batchIterator)

		await Placetype.prepare({
			batchSize: BATCH_SIZE,
			localRepoDirectory,
		})
	})

	if (state.status === "error") {
		return <Text color="red">✗ {state.message}</Text>
	}

	if (!repos) {
		return <Text>Fetching repo list...</Text>
	}

	if (!repos.length) {
		return <Text>No repositories found</Text>
	}

	return (
		<Box flexDirection="column">
			<Box>
				<Text>Inserted {formatQuantity(syncCount)}</Text>
				<Text>&nbsp;of&nbsp;{formatQuantity(repos.length)}</Text>
				<Text>&nbsp;records</Text>
			</Box>

			<Box paddingX={1}>
				<ProgressBar value={percentage} />
				<Text>{percentage.toFixed(2)}%</Text>
			</Box>
		</Box>
	)
}

export default WOFSync
