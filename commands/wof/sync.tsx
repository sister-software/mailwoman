/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { ProgressBar } from "@inkjs/ui"
import {
	formatQuantity,
	Placetype,
	PLACETYPES_REPO_SOURCE,
	RepositorySource,
	synchronizeRepo,
	takeInParallel,
} from "@mailwoman/core"
import { Box, Text } from "ink"
import { availableParallelism } from "node:os"
import { PathBuilder } from "path-ts"
import { useEffect, useMemo, useState } from "react"
import zod from "zod"
import { $ } from "zx"
import { CommandComponent } from "../../sdk/cli.js"

const BATCH_SIZE = availableParallelism()
const WOF_REPO_OWNER = "whosonfirst-data"

const ArgumentsSchema = zod.array(zod.string().describe("Path to the Who's On First repository admin directory"))

/**
 * `--repos` is a comma-separated allow-list of repo names. When set, the discovery step still
 * queries `gh repo list` for `whosonfirst-data/*` but filters down to only repos whose `name` is
 * present in the list. When absent, every non-archived repo in the org is synced (the original
 * behavior).
 *
 * The corpus build only needs a small subset (4 repos for US+FR admin+postalcode + the placetypes
 * codex). Cloning all ~100 whosonfirst-data repos is otherwise ~2.9 GB of git for no reason.
 */
const OptionsSchema = zod.object({
	repos: zod
		.string()
		.optional()
		.describe(
			"Optional comma-separated allow-list of repo names under whosonfirst-data/. When set, only the listed repos are cloned/pulled (placetypes is always included). Example: --repos whosonfirst-data-admin-us,whosonfirst-data-admin-fr,whosonfirst-data-postalcode-us,whosonfirst-data-postalcode-fr"
		),
})

export { ArgumentsSchema as args, OptionsSchema as options }

function parseReposFilter(raw: string | undefined): Set<string> | undefined {
	if (!raw) return undefined
	const allow = new Set(
		raw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)
	)
	return allow.size > 0 ? allow : undefined
}

const WOFSync: CommandComponent<typeof OptionsSchema, typeof ArgumentsSchema> = ({ options, args }) => {
	const [repos, setRepos] = useState<RepositorySource[]>()
	const localRepoDirectory = useMemo(() => PathBuilder.from(args[0]!), [args])
	const [syncCount, setSyncCount] = useState(0)
	const percentage = Array.isArray(repos) ? (syncCount / repos.length) * 100 : 0

	const allow = useMemo(() => parseReposFilter(options.repos), [options.repos])

	useEffect(() => {
		const discovered = $.sync`gh repo list ${WOF_REPO_OWNER} --no-archived --json 'name' --json 'url'`
			.json<Omit<RepositorySource, "owner">[]>()
			.map((entry): RepositorySource => ({ ...entry, owner: WOF_REPO_OWNER }))

		const filtered = allow ? discovered.filter((entry) => allow.has(entry.name)) : discovered
		setRepos([...filtered, PLACETYPES_REPO_SOURCE])
	}, [localRepoDirectory, allow])

	useEffect(() => {
		if (!repos || !repos.length) return

		const abortController = new AbortController()

		const batchIterator = takeInParallel(
			repos,
			BATCH_SIZE,
			async (entry) => {
				await synchronizeRepo(entry, localRepoDirectory)

				setSyncCount((count) => count + 1)
			},
			abortController.signal
		)

		Array.fromAsync(batchIterator)

		return () => {
			abortController.abort()
		}
	}, [repos, localRepoDirectory])

	useEffect(() => {
		if (!repos) return
		if (syncCount < repos.length) return

		Placetype.prepare({
			batchSize: BATCH_SIZE,
			localRepoDirectory,
		})
	}, [localRepoDirectory, repos, syncCount])

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
