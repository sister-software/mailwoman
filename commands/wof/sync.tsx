/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { ProgressBar } from "@inkjs/ui"
import { Box, Text } from "ink"
import {
	formatQuantity,
	Placetype,
	PLACETYPES_REPO_SOURCE,
	RepositorySource,
	synchronizeRepo,
	takeInParallel,
} from "mailwoman/core"
import { PositionalCommandComponent } from "mailwoman/sdk/cli"
import { availableParallelism } from "node:os"
import { PathBuilder } from "path-ts"
import { useEffect, useMemo, useState } from "react"
import zod from "zod"
import { $ } from "zx"

const BATCH_SIZE = availableParallelism()
const WOF_REPO_OWNER = "whosonfirst-data"

const ArgumentsSchema = zod.array(zod.string().describe("Path to the Who's On First repository admin directory"))
export { ArgumentsSchema as args }

const WOFSync: PositionalCommandComponent<typeof ArgumentsSchema> = ({ args }) => {
	const [repos, setRepos] = useState<RepositorySource[]>()
	const localRepoDirectory = useMemo(() => PathBuilder.from(args[0]!), [args])
	const [syncCount, setSyncCount] = useState(0)
	const percentage = Array.isArray(repos) ? (syncCount / repos.length) * 100 : 0

	useEffect(() => {
		const result = $.sync`gh repo list ${WOF_REPO_OWNER} --no-archived --json 'name' --json 'url'`
			.json<Omit<RepositorySource, "owner">[]>()
			.map((entry): RepositorySource => ({ ...entry, owner: WOF_REPO_OWNER }))

		setRepos([...result, PLACETYPES_REPO_SOURCE])
	}, [localRepoDirectory])

	useEffect(() => {
		if (!repos || !repos.length) return

		const abortController = new AbortController()

		const batchIterator = takeInParallel(
			repos,
			BATCH_SIZE,
			async (entry) => {
				console.log(`Syncing ${entry.name}`)

				if (!Date.now()) {
					await synchronizeRepo(entry, localRepoDirectory)
				}

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
