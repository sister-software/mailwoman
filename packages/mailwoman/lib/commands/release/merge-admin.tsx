/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman release merge-admin` — the ONE sanctioned `gh pr merge --admin` route (#1895). The
 *   bypass stays available for the nights the lab fleet is slow, but it runs the sub-second guards
 *   the skipped checks would have, synchronously, and refuses to merge over a failure.
 *
 *   Contract: the LOCAL checkout must be at the PR's head commit — the guards measure the tree they
 *   run in, and measuring a different tree than the one being merged answers a question nobody
 *   asked. The command verifies the SHA and refuses with the checkout command otherwise.
 */

import { gitHead } from "@mailwoman/core/git"
import { parseJSONStrict } from "@mailwoman/core/json"
import { repoRootPath } from "@mailwoman/core/paths"
import { Box, Text } from "ink"
import { $ } from "zx"

import {
	type CommandSpec,
	CommandTaskResult,
	CLIUsageError,
	type ParsedCommandComponent,
	useCommandTask,
} from "#cli-kit"

export const description = "Admin-merge a pull request after running the sub-second guards the skipped checks carry."

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "merge-admin",
	description,
	positionals: [{ name: "pr", required: true, description: "Pull request number" }],
	options: {
		method: { type: "string", default: "merge", description: "Merge method: merge, squash, or rebase" },
	},
} as const satisfies CommandSpec

interface Options {
	method: string
}

const MERGE_METHODS = ["merge", "squash", "rebase"] as const

/**
 * The paths whose change makes the board-pin guard mandatory: the corpus rows themselves, the loader/fingerprint
 * implementation, the pins API, and the pin test. The same three filters `.github/workflows/board-pins.yml` triggers
 * on.
 */
const BOARD_PIN_PATHS = [
	/^packages\/mailwoman\/lib\/eval-harness\/gauntlet\/cases\//,
	/^packages\/mailwoman\/lib\/eval-harness\/gauntlet\/ablation\.ts$/,
	/^packages\/mailwoman\/test\/unit\/eval-harness\/gauntlet\/cases\/load\.test\.ts$/,
]

interface MergeAdminResult {
	prNumber: string
	title: string
	method: string
	ranChecks: string[]
	mergeOutput: string
}

async function mergeAdmin(prNumber: string, method: string): Promise<MergeAdminResult> {
	if (!/^\d+$/.test(prNumber)) {
		throw new CLIUsageError(`the pull request must be a number, got ${JSON.stringify(prNumber)}`)
	}

	if (!MERGE_METHODS.includes(method as (typeof MERGE_METHODS)[number])) {
		throw new CLIUsageError(`--method ${JSON.stringify(method)} is not one of ${MERGE_METHODS.join("|")}`)
	}

	const prView = await $`gh pr view ${prNumber} --json state,title,headRefOid,files`.quiet()

	const pr = parseJSONStrict<{
		state: string
		title: string
		headRefOid: string
		files: Array<{ path: string }>
	}>(prView.stdout)

	if (pr.state !== "OPEN") {
		throw new Error(`PR #${prNumber} is ${pr.state}, not OPEN.`)
	}

	const localHead = await gitHead(repoRootPath())

	if (localHead !== pr.headRefOid) {
		throw new Error(
			`the local checkout is at ${localHead.slice(0, 12)} but PR #${prNumber}'s head is ` +
				`${pr.headRefOid.slice(0, 12)} — the guards measure the tree they run in, so check the PR out first:\n` +
				`  gh pr checkout ${prNumber}`
		)
	}

	const changed = pr.files.map((file) => file.path)
	const ranChecks: string[] = []

	if (changed.some((path) => BOARD_PIN_PATHS.some((pattern) => pattern.test(path)))) {
		const { checkBoardPins } = await import("#eval-harness/gauntlet/cases/pins")
		const check = await checkBoardPins()

		ranChecks.push(`board-pins (${check.measured.CORPUS_SIZE} rows)`)

		if (check.stale.length) {
			const drift = check.stale
				.map((key) => `  ${key}: committed ${String(check.committed[key])} → measured ${String(check.measured[key])}`)
				.join("\n")

			throw new Error(
				`REFUSING to admin-merge PR #${prNumber} — the board pins are stale on its head:\n${drift}\n` +
					"Run `mailwoman eval pins --update`, commit, and re-run."
			)
		}
	}

	const methodFlag = `--${method}`
	const merged = await $`gh pr merge ${prNumber} --admin ${methodFlag}`.quiet()

	return { prNumber, title: pr.title, method, ranChecks, mergeOutput: merged.stdout.trim() }
}

const ReleaseMergeAdmin: ParsedCommandComponent<Options, [string]> = ({ options, args }) => {
	const state = useCommandTask(() => mergeAdmin(args[0], options.method))

	if (state.status !== "done") {
		return <CommandTaskResult state={state} running={<Text dimColor>Checking the pull request…</Text>} />
	}

	const { result } = state

	return (
		<Box flexDirection="column">
			<Text dimColor>
				checks run: {result.ranChecks.length ? result.ranChecks.join(", ") : "none applicable to the changed paths"}
			</Text>
			<Text color="green">
				✓ merged PR #{result.prNumber} ({result.title}) with --admin --{result.method}
			</Text>
			{result.mergeOutput ? <Text dimColor>{result.mergeOutput}</Text> : null}
		</Box>
	)
}

export default ReleaseMergeAdmin
