/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Replays CI test selection over recorded history without running a test.
 *
 *   For each first-parent commit below a ref, the replay selects the tests the commit's diff requires under the
 *   checkout's own selection rule. For each recorded `Test` run on `main` that failed, it selects the tests the push's
 *   diff requires and lists the failing test files the run's log reports. Two replays of the same history, one per
 *   rule, are compared row by row with {@linkcode compareCIReplays}.
 *
 *   The workspace graph and the related-test readers come from the checkout as it is now, so a commit's diff is
 *   selected against today's graph rather than the graph at that commit.
 */

import { git, trackedFiles } from "@mailwoman/core/git"
import { parseJSONStrict } from "@mailwoman/core/json"
import { runFile } from "@mailwoman/core/process"
import { stripANSI } from "@mailwoman/core/strings/terminal"
import { TextSpliterator } from "spliterator"
import { z } from "zod"

import { computeCIScope, readPublishedWorkspaces } from "#repo-health/actions-output"
import { createCIRelatedReader } from "#repo-health/ci/related"
import { readCIWorkspaces } from "#repo-health/ci/scope"

/**
 * The tests one diff selects.
 */
export interface ReplaySelection {
	sha: string
	base: string
	changed: number
	full: boolean
	fastFiles: string[]
	slowFiles: string[]
}

/**
 * A failed `Test` run on `main`, the push diff it tested, the failing test files its
 * log reports, and the tests the replayed rule selects for that diff.
 */
interface ReplayFailure {
	runID: number
	sha: string
	base: string
	failedTests: string[]
	selection: ReplaySelection
}

/**
 * A failed `Test` run the replay could not check, and why.
 */
interface UncheckedRun {
	runID: number
	sha: string
	reason: string
}

export interface CIReplay {
	/**
	 * The checkout commit whose selection rule produced the replay.
	 */
	checkout: string
	ref: string
	commits: ReplaySelection[]
	failures: ReplayFailure[]
	/**
	 * The failed runs left out of `failures`: an expired log, a commit the clone lacks,
	 * or a failure outside the tests.
	 */
	unchecked: UncheckedRun[]
}

/**
 * The buffer for the log `gh run view --log-failed` writes.
 * That log can exceed `execFile`'s default of 1 MiB.
 */
const GH_LOG_BUFFER = 512 * 1024 * 1024

/**
 * An ANSI color sequence in the caret notation `gh run view --log` writes it in: `^[[41m` for ESC `[41m`.
 */
const CARET_COLOR_SEQUENCE = /\^\[\[[0-9;]*m/gu

/**
 * The test files a Vitest log reports as failed, from its ` FAIL  <file> > <test>` lines.
 *
 * The log may hold its color codes as escape bytes or in caret notation, so both are removed first.
 */
export function failedTestFiles(log: string): string[] {
	const files = new Set<string>()
	const plain = stripANSI(log).replaceAll(CARET_COLOR_SEQUENCE, "")

	for (const match of plain.matchAll(/\bFAIL\s+((?:packages|lib|docs)\/\S+?\.test\.tsx?)\b/gu)) {
		const [, file] = match

		if (file) {
			files.add(file)
		}
	}

	return [...files].toSorted()
}

async function changedBetween(root: string, base: string, head: string): Promise<string[]> {
	const output = await git(
		["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`, "--"],
		root,
		64 * 1024 * 1024
	)

	return output.split("\0").filter((path) => path.length > 0)
}

async function hasCommit(root: string, sha: string): Promise<boolean> {
	return git(["cat-file", "-t", sha], root).then(
		(type) => type.trim() === "commit",
		() => false
	)
}

const RecordedRuns = z.array(z.object({ databaseId: z.number(), headSha: z.string(), conclusion: z.string() }))

export interface CIReplayOptions {
	/**
	 * The commit whose first-parent history is replayed.
	 */
	ref: string
	commits: number
	/**
	 * The number of recorded `Test` runs on `main` to read for failures.
	 */
	runs: number
}

/**
 * Replays the checkout's selection rule over the history below `options.ref`
 * and over the failed `Test` runs.
 */
export async function replayCIScope(root: string, options: CIReplayOptions): Promise<CIReplay> {
	const files = await trackedFiles(root)
	const workspaces = await readCIWorkspaces(root, files)
	const published = await readPublishedWorkspaces(root)

	await using fast = await createCIRelatedReader(root, "vitest.fast.config.ts")
	await using slow = await createCIRelatedReader(root, "vitest.slow.config.ts")

	const related = new Map<string, Promise<string[]>>()

	const readRelated = (changed: readonly string[], config: string): Promise<string[]> => {
		const key = `${config}\u0000${[...changed].toSorted().join("\u0000")}`
		let found = related.get(key)

		if (!found) {
			found = (config === "vitest.slow.config.ts" ? slow : fast).read(changed)
			related.set(key, found)
		}

		return found
	}

	const select = async (base: string, sha: string): Promise<ReplaySelection> => {
		const changed = await changedBetween(root, base, sha)
		const scope = await computeCIScope({ workspaces, files, changed, published, forceFull: false, readRelated })

		return {
			sha,
			base,
			changed: changed.length,
			full: scope.full,
			fastFiles: scope.full ? [] : scope.fastFiles,
			slowFiles: scope.full ? [] : scope.slowFiles,
		}
	}

	const shas = TextSpliterator.from(
		await git(["log", "--first-parent", "--format=%H", "-n", String(options.commits + 1), options.ref], root)
	).toArray()

	const commits: ReplaySelection[] = []

	for (const [index, sha] of shas.slice(0, -1).entries()) {
		commits.push(await select(shas[index + 1]!, sha))
	}

	const { stdout } = await runFile("gh", [
		"run",
		"list",
		"--workflow",
		"Test",
		"--branch",
		"main",
		"--limit",
		String(options.runs),
		"--json",
		"databaseId,headSha,conclusion",
	])

	const runs = RecordedRuns.parse(parseJSONStrict(stdout))
	const failures: ReplayFailure[] = []
	const unchecked: UncheckedRun[] = []

	// Runs are listed newest first, so the next entry is the push before this one.
	for (const [index, run] of runs.entries()) {
		const previous = runs[index + 1]

		if (run.conclusion !== "failure" || !previous || previous.headSha === run.headSha) continue

		const skip = (reason: string): void => {
			unchecked.push({ runID: run.databaseId, sha: run.headSha, reason })
		}

		if (!(await hasCommit(root, run.headSha)) || !(await hasCommit(root, previous.headSha))) {
			skip("the clone lacks the run's commit or the previous run's commit")

			continue
		}

		const log = await runFile("gh", ["run", "view", String(run.databaseId), "--log-failed"], {
			maxBuffer: GH_LOG_BUFFER,
		}).then(
			(output) => output.stdout,
			(error: unknown) => {
				skip(`gh could not read the run's log: ${error instanceof Error ? error.message.trim() : String(error)}`)

				return null
			}
		)

		if (log === null) continue

		const failedTests = failedTestFiles(log)

		if (!failedTests.length) {
			skip("the run's failed jobs report no failing test file")

			continue
		}

		failures.push({
			runID: run.databaseId,
			sha: run.headSha,
			base: previous.headSha,
			failedTests,
			selection: await select(previous.headSha, run.headSha),
		})
	}

	return {
		checkout: (await git(["rev-parse", "HEAD"], root)).trim(),
		ref: options.ref,
		commits,
		failures,
		unchecked,
	}
}

/**
 * One commit's selections under the two rules, with the test files only one of them selects.
 */
interface ReplayCommitComparison {
	sha: string
	before: number
	after: number
	onlyBefore: string[]
	onlyAfter: string[]
}

/**
 * A recorded failing test file and the rules that select it for the push it failed on.
 */
interface ReplayFailureComparison {
	runID: number
	sha: string
	file: string
	selectedBefore: boolean
	selectedAfter: boolean
}

export interface ReplayComparison {
	commits: number
	/**
	 * Commits each rule selects in full.
	 * The comparison leaves these out of its sums and classes.
	 */
	fullBefore: number
	fullAfter: number
	/**
	 * Selected test files summed over every commit that neither rule selects in full.
	 */
	selectedBefore: number
	selectedAfter: number
	narrower: number
	wider: number
	mixed: number
	equal: number
	rows: ReplayCommitComparison[]
	failures: ReplayFailureComparison[]
	/**
	 * Failed runs only one replay could check, as when `gh` answered an HTTP error for the other.
	 *
	 * The failure check leaves them out, and the list states that it did.
	 */
	unpairedRuns: Array<{ runID: number; checkedIn: "before" | "after" }>
}

const selectedFiles = (selection: ReplaySelection): Set<string> =>
	new Set([...selection.fastFiles, ...selection.slowFiles])

/**
 * Pairs two replays of the same history by commit, and checks each recorded failing test against both rules.
 *
 * @throws When the replays cover different commits, because rows from different histories do not pair.
 */
export function compareCIReplays(before: CIReplay, after: CIReplay): ReplayComparison {
	const afterBySHA = new Map(after.commits.map((selection) => [selection.sha, selection]))

	if (before.commits.length !== after.commits.length || before.commits.some((row) => !afterBySHA.has(row.sha))) {
		throw new Error(`The replays cover different commits: ${before.ref} and ${after.ref}`)
	}

	const comparison: ReplayComparison = {
		commits: before.commits.length,
		fullBefore: 0,
		fullAfter: 0,
		selectedBefore: 0,
		selectedAfter: 0,
		narrower: 0,
		wider: 0,
		mixed: 0,
		equal: 0,
		rows: [],
		failures: [],
		unpairedRuns: [],
	}

	for (const old of before.commits) {
		const now = afterBySHA.get(old.sha)!

		if (old.full) {
			comparison.fullBefore++
		}

		if (now.full) {
			comparison.fullAfter++
		}

		if (old.full || now.full) continue

		const oldFiles = selectedFiles(old)
		const newFiles = selectedFiles(now)
		const onlyBefore = [...oldFiles].filter((file) => !newFiles.has(file)).toSorted()
		const onlyAfter = [...newFiles].filter((file) => !oldFiles.has(file)).toSorted()

		comparison.selectedBefore += oldFiles.size
		comparison.selectedAfter += newFiles.size

		if (onlyBefore.length && onlyAfter.length) {
			comparison.mixed++
		} else if (onlyBefore.length) {
			comparison.narrower++
		} else if (onlyAfter.length) {
			comparison.wider++
		} else {
			comparison.equal++
		}

		if (onlyBefore.length || onlyAfter.length) {
			comparison.rows.push({ sha: old.sha, before: oldFiles.size, after: newFiles.size, onlyBefore, onlyAfter })
		}
	}

	const afterFailures = new Map(after.failures.map((failure) => [failure.runID, failure]))
	const beforeRuns = new Set(before.failures.map((failure) => failure.runID))

	for (const failure of after.failures) {
		if (!beforeRuns.has(failure.runID)) {
			comparison.unpairedRuns.push({ runID: failure.runID, checkedIn: "after" })
		}
	}

	for (const failure of before.failures) {
		const now = afterFailures.get(failure.runID)

		if (!now) {
			comparison.unpairedRuns.push({ runID: failure.runID, checkedIn: "before" })

			continue
		}

		const oldFiles = selectedFiles(failure.selection)
		const newFiles = selectedFiles(now.selection)

		for (const file of failure.failedTests) {
			comparison.failures.push({
				runID: failure.runID,
				sha: failure.sha,
				file,
				selectedBefore: failure.selection.full || oldFiles.has(file),
				selectedAfter: now.selection.full || newFiles.has(file),
			})
		}
	}

	return comparison
}
