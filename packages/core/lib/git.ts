/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The one home for running git: {@linkcode GitClient} and the readers built on it.
 *
 *   A `GitClient` is bound to one directory. Short reads such as `rev-parse` answer their stdout.
 *   Long transfers such as `clone` and `fetch` run as a {@linkcode ProcessTask} with `--progress`,
 *   and the client re-dispatches each parsed progress line, so a command renders one stream for every repository it touches.
 *   Disposing the client stops every git process it started.
 *
 *   The free functions below are the same readers for a caller that needs one answer about the working tree.
 */

import { asyncInit } from "async-init"
import type { PathBuilderLike } from "path-ts"
import { TextSpliterator } from "spliterator"

import type { IRuntimeLogger } from "#logging"
import { repoRootPathBuilder } from "#paths"
import {
	type ProcessProgress,
	type ProcessResult,
	ProcessTask,
	type ProcessTaskOptions,
	runFile,
	runFileSync,
} from "#process"
import { TypedEventTarget } from "#utils/events"

/**
 * The stdout ceiling for a git read that lists paths or history.
 */
const LISTING_MAX_BUFFER = 64 * 1024 * 1024

/**
 * Git's progress meter, as it writes one redraw to stderr under `--progress`:
 * `Receiving objects:  45% (450/1000), 1.20 MiB | 2.40 MiB/s`, or the same line
 * prefixed with `remote: ` when the server reports it.
 */
const GIT_PROGRESS_PATTERN = /^(?:remote: )?([A-Z][A-Za-z ]+):\s+(\d{1,3})% \((\d+)\/(\d+)\)/u

/**
 * Read one stderr line of a git transfer as progress, or `null` for any other line.
 */
export function parseGitProgress(line: string): ProcessProgress | null {
	const match = GIT_PROGRESS_PATTERN.exec(line)

	if (!match) return null

	return {
		stage: match[1]!,
		percent: Number(match[2]),
		processed: Number(match[3]),
		total: Number(match[4]),
	}
}

/**
 * One progress step from a git transfer, with the command line it came from.
 */
export interface GitProgress extends ProcessProgress {
	command: string
}

/**
 * The events a {@linkcode GitClient} dispatches, keyed by type, with each event's `detail`.
 */
export interface GitClientEventMap {
	progress: GitProgress
}

/**
 * Options for {@linkcode GitClient}.
 */
export interface GitClientOptions {
	/**
	 * The directory git runs in.
	 *
	 * @defaultValue the repository root
	 */
	cwd?: PathBuilderLike
	logger?: IRuntimeLogger
	/**
	 * Aborting the signal stops every git process the client started.
	 */
	signal?: AbortSignal
}

/**
 * Options for a single git read.
 */
export interface GitReadOptions {
	/**
	 * The stdout ceiling in bytes.
	 *
	 * A read past it rejects rather than answering a truncated listing.
	 */
	maxBuffer?: number
	/**
	 * Whether to remove surrounding whitespace from stdout.
	 *
	 * Porcelain output starts with a status column that may be a space, so a porcelain read passes `false`.
	 *
	 * @defaultValue `true`
	 */
	trim?: boolean
}

/**
 * Options for a git transfer.
 */
export interface GitTransferOptions extends Pick<ProcessTaskOptions, "stdin" | "stdout" | "rawStdout"> {
	/**
	 * Whether a non-zero exit rejects the transfer.
	 *
	 * @defaultValue `true`
	 */
	reject?: boolean
}

/**
 * A git runner bound to one directory, modeled on `APIClient`.
 *
 * Its reads answer stdout with the trailing newline removed.
 * Its transfers report progress as `progress` events.
 *
 * Disposal stops every process the client started and waits for each to exit.
 *
 * Initialize it with `construct(GitClient, options)` from `async-init` to resolve
 * {@linkcode GitClient.root} and {@linkcode GitClient.commonDirectory} before use.
 * A client that will clone into a directory that does not exist yet is used without initialization.
 */
export class GitClient extends TypedEventTarget<GitClientEventMap> implements AsyncDisposable {
	public readonly cwd: PathBuilderLike
	public readonly logger: IRuntimeLogger | undefined

	/**
	 * The working-tree root, set by initialization.
	 */
	public root: string | null = null
	/**
	 * The shared `.git` directory, set by initialization.
	 *
	 * The main checkout and each of its worktrees report the same directory.
	 */
	public commonDirectory: string | null = null

	readonly #shutdown = new AbortController()
	readonly #tasks = new Set<ProcessTask>()
	#disposePromise: Promise<void> | null = null

	constructor(options: GitClientOptions = {}) {
		super()

		this.cwd = options.cwd ?? repoRootPathBuilder
		this.logger = options.logger

		options.signal?.addEventListener("abort", () => void this[Symbol.asyncDispose](), { once: true })
	}

	public async [asyncInit](): Promise<void> {
		this.root = await this.read(["rev-parse", "--show-toplevel"])
		this.commonDirectory = await this.read(["rev-parse", "--path-format=absolute", "--git-common-dir"])
	}

	/**
	 * Run git to completion and answer stdout with surrounding whitespace removed.
	 *
	 * A non-zero exit rejects with a `ProcessError` carrying git's stderr.
	 */
	public async read(args: string | readonly string[], options: GitReadOptions = {}): Promise<string> {
		this.#shutdown.signal.throwIfAborted()

		const argumentList = typeof args === "string" ? [args] : args

		this.logger?.debug(`$ git ${argumentList.join(" ")}`)

		const { stdout } = await runFile("git", argumentList, {
			cwd: this.cwd,
			maxBuffer: options.maxBuffer,
			signal: this.#shutdown.signal,
		})

		return options.trim === false ? stdout : stdout.trim()
	}

	/**
	 * Start git as a {@linkcode ProcessTask} whose parsed progress lines the client re-dispatches.
	 *
	 * The caller passes `--progress` where the subcommand accepts it.
	 * Git writes the meter only to a terminal unless asked.
	 */
	public start(args: readonly string[], options: GitTransferOptions = {}): ProcessTask {
		this.#shutdown.signal.throwIfAborted()

		const task = new ProcessTask("git", args, {
			stdin: options.stdin,
			stdout: options.stdout,
			rawStdout: options.rawStdout,
			cwd: this.cwd,
			logger: this.logger,
			reject: options.reject,
			signal: this.#shutdown.signal,
			progress: parseGitProgress,
		})

		this.#tasks.add(task)

		task.on("progress", (step) => this.emit("progress", { ...step, command: task.command }))
		void task.result.finally(() => this.#tasks.delete(task)).catch(() => undefined)

		return task
	}

	/**
	 * Clone `url` into `directory`, shallow when `depth` is given.
	 */
	public clone(
		url: string,
		directory: PathBuilderLike,
		options: GitTransferOptions & { depth?: number } = {}
	): Promise<ProcessResult> {
		const depth = typeof options.depth !== "number" ? [] : ["--depth", String(options.depth)]

		return this.start(["clone", "--progress", ...depth, url, directory.toString()], options).result
	}

	/**
	 * Fetch `remote` into the client's repository.
	 */
	public fetch(remote = "origin", options: GitTransferOptions = {}): Promise<ProcessResult> {
		return this.start(["fetch", "--progress", remote], options).result
	}

	/**
	 * Pull the current branch's upstream into the client's repository.
	 */
	public pull(options: GitTransferOptions = {}): Promise<ProcessResult> {
		return this.start(["pull", "--progress"], options).result
	}

	/**
	 * The commit `HEAD` refers to, as a full SHA or, with `short`, git's abbreviation.
	 */
	public head(options: { short?: boolean } = {}): Promise<string> {
		return this.read(options.short ? ["rev-parse", "--short", "HEAD"] : ["rev-parse", "HEAD"])
	}

	/**
	 * The checked-out branch name, or `HEAD` when the tree is detached.
	 */
	public currentBranch(): Promise<string> {
		return this.read(["rev-parse", "--abbrev-ref", "HEAD"])
	}

	/**
	 * `git status --porcelain` lines, narrowed by pathspecs.
	 *
	 * Untracked files are included unless `untracked` is `false`.
	 */
	public async status(pathspecs: readonly string[] = [], options: { untracked?: boolean } = {}): Promise<string[]> {
		const scope = pathspecs.length ? ["--", ...pathspecs] : []
		const untracked = options.untracked === false ? ["--untracked-files=no"] : []
		const output = await this.read(["status", "--porcelain", ...untracked, ...scope], { trim: false })

		// `trim: false` keeps the status column, whose first character is a space for an unstaged change.
		return TextSpliterator.from(output, { trim: false })
			.map((line) => line.trimEnd())
			.filter((line) => line.length)
			.toArray()
	}

	/**
	 * Run git and split its NUL-delimited stdout into the non-empty fields.
	 */
	public async readNulDelimited(args: readonly string[]): Promise<string[]> {
		const output = await this.read(args, { maxBuffer: LISTING_MAX_BUFFER })

		return output.split("\0").filter((field) => field.length)
	}

	/**
	 * Run git and answer its stdout's non-empty lines.
	 */
	public async readLines(args: readonly string[]): Promise<string[]> {
		const output = await this.read(args, { maxBuffer: LISTING_MAX_BUFFER })

		return TextSpliterator.from(output)
			.map((line) => line.trimEnd())
			.filter((line) => line.length)
			.toArray()
	}

	/**
	 * Disposal stops every git process the client started and waits for each to exit.
	 * Repeated calls return the same promise.
	 */
	public [Symbol.asyncDispose](): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise

		this.#shutdown.abort(new Error(`git client for ${this.cwd} is disposed`))

		this.#disposePromise = Promise.all([...this.#tasks].map((task) => task[Symbol.asyncDispose]())).then(
			() => undefined
		)

		return this.#disposePromise
	}
}

/**
 * Options for {@linkcode gitSync}.
 */
export interface GitSyncOptions {
	cwd?: PathBuilderLike
	env?: NodeJS.ProcessEnv
	/**
	 * Whether to remove surrounding whitespace from stdout.
	 *
	 * @defaultValue `true`
	 */
	trim?: boolean
}

/**
 * Run git synchronously and answer stdout, for a slot whose caller is synchronous.
 *
 * Git's stderr is captured rather than written to the terminal.
 * A non-zero exit throws the builtin's error, which carries that stderr.
 */
export function gitSync(args: readonly string[], options: GitSyncOptions = {}): string {
	const stdout = runFileSync("git", args, {
		cwd: options.cwd ?? repoRootPathBuilder,
		env: options.env,
		stdio: "pipe",
		maxBuffer: LISTING_MAX_BUFFER,
	})

	return options.trim === false ? stdout : stdout.trim()
}

/**
 * Run a git command in the given repository.
 *
 * @returns stdout as a string.
 */
export async function git(
	args: string | string[],
	repoRoot: PathBuilderLike = repoRootPathBuilder,
	maxBuffer?: number
): Promise<string> {
	return new GitClient({ cwd: repoRoot }).read(args, { maxBuffer })
}

/**
 * The commit head names, as a full SHA (or the short form the `--short` flag abbreviates to).
 */
export async function gitHead(
	repoRoot: PathBuilderLike = repoRootPathBuilder,
	options: { short?: boolean } = {}
): Promise<string> {
	return new GitClient({ cwd: repoRoot }).head(options)
}

/**
 * The checked-out branch name, or `head` when the tree is detached.
 */
export async function currentBranch(repoRoot: PathBuilderLike = repoRootPathBuilder): Promise<string> {
	return new GitClient({ cwd: repoRoot }).currentBranch()
}

/**
 * The absolute path of the repository's shared `.git` directory.
 *
 * The main checkout and each of its worktrees report the same directory.
 */
export async function gitCommonDirectory(repoRoot: PathBuilderLike = repoRootPathBuilder): Promise<string> {
	return git(["rev-parse", "--path-format=absolute", "--git-common-dir"], repoRoot)
}

/**
 * The absolute path of the working tree that contains `repoRoot`.
 */
export async function workingTreeRoot(repoRoot: PathBuilderLike = repoRootPathBuilder): Promise<string> {
	return git(["rev-parse", "--show-toplevel"], repoRoot)
}

/**
 * `git status --porcelain` lines for tracked files with uncommitted changes.
 *
 * Untracked files are excluded because materialized weight binaries
 * and compiled `out/` trees are gitignored.
 * A publish path creates both before publishing.
 * Pathspecs narrow the reading to caller-supplied paths.
 */
export async function dirtyTrackedFiles(
	repoRoot: PathBuilderLike = repoRootPathBuilder,
	pathspecs: string[] = []
): Promise<string[]> {
	return new GitClient({ cwd: repoRoot }).status(pathspecs, { untracked: false })
}

/**
 * Every `git status --porcelain` line, staged and unstaged and untracked alike.
 *
 * The sibling {@linkcode dirtyTrackedFiles} answers a publish path's question about changed committed files.
 * It excludes build outputs.
 *
 * This answers a cache's question: has anything at all changed since a derived artifact was built.
 *
 * A key built from the narrower reading goes stale after a staged edit or a new file.
 * and a stale index reports that a helper written an hour ago does not exist.
 */
export async function workingTreeStatus(
	repoRoot: PathBuilderLike = repoRootPathBuilder,
	pathspecs: string[] = []
): Promise<string[]> {
	return new GitClient({ cwd: repoRoot }).status(pathspecs)
}

/**
 * The repo-relative paths that differ between two commits, added, modified, renamed
 * or deleted alike, read NUL-delimited so an unusual path survives.
 *
 * Both commits must be present in the checkout: a shallow clone that lacks `base` fails
 * here with git's own message rather than answering an empty list.
 */
export async function changedFiles(
	repoRoot: PathBuilderLike = repoRootPathBuilder,
	base: string,
	head: string
): Promise<string[]> {
	return new GitClient({ cwd: repoRoot }).readNulDelimited(["diff", "--name-only", "-z", base, head])
}

/**
 * The renames between `ref` and the working tree, as repo-relative `{from, to}` pairs.
 *
 * Rename detection runs with git's default similarity threshold.
 * The output is read NUL-delimited, where each rename is a status field followed by its two paths.
 */
export async function renamesSince(
	ref: string,
	repoRoot: PathBuilderLike = repoRootPathBuilder
): Promise<Array<{ from: string; to: string }>> {
	const fields = (await git(["diff", "--name-status", "-M", "-z", ref], repoRoot, LISTING_MAX_BUFFER)).split("\0")
	const renames: Array<{ from: string; to: string }> = []

	for (let index = 0; index < fields.length;) {
		const status = fields[index]!

		if (!status) break

		if (status.startsWith("R") || status.startsWith("C")) {
			if (status.startsWith("R")) {
				renames.push({ from: fields[index + 1]!, to: fields[index + 2]! })
			}

			index += 3
		} else {
			index += 2
		}
	}

	return renames
}

/**
 * Every path `ref` tracks, repo-relative, read NUL-delimited.
 */
export async function filesAtRef(ref: string, repoRoot: PathBuilderLike = repoRootPathBuilder): Promise<string[]> {
	return new GitClient({ cwd: repoRoot }).readNulDelimited(["ls-tree", "-r", "--name-only", "-z", ref])
}

/**
 * Every tracked path, repo-relative, optionally narrowed by git pathspecs.
 *
 * Read NUL-delimited so a path with a newline or a non-ascii byte survives.
 * The 64 MiB buffer covers this repository's listing several times over.
 */
export async function trackedFiles(
	repoRoot: PathBuilderLike = repoRootPathBuilder,
	pathspecs: string[] = []
): Promise<string[]> {
	return new GitClient({ cwd: repoRoot }).readNulDelimited(["ls-files", "-z", ...pathspecs])
}

/**
 * Every path in the working tree that Git includes, repo-relative: the tracked ones
 * and the untracked ones an ignore rule does not cover, optionally narrowed by git pathspecs.
 *
 * This is the set a checker over repository contents needs. {@linkcode trackedFiles}
 * answers what is committed.
 * A newly written file is absent from that set, so a checker could report a clean result without opening it.
 *
 * `--exclude-standard` applies `.gitignore`, so a build output stays out
 * and only a file somebody intends to commit comes in.
 */
export async function workingTreeFiles(
	pathspecs: string[] = [],
	repoRoot: PathBuilderLike = repoRootPathBuilder
): Promise<string[]> {
	return new GitClient({ cwd: repoRoot }).readNulDelimited([
		"ls-files",
		"-z",
		"--cached",
		"--others",
		"--exclude-standard",
		...pathspecs,
	])
}

/**
 * Every path this repository has ever renamed away from or deleted, across all refs.
 *
 * The set that separates a reference to something that moved from a reference
 * to something that never existed.
 * The distinction a path-literal sweep turns on, because a path a tool writes
 * and a path a fixture invents are both absent from the tree and neither is a defect.
 *
 * `--no-renames` is what makes it answer the question asked.
 * With rename detection on, `--name-only` prints a rename's destination.
 *
 * The old path never appears, so the result contains only paths that still exist.
 *
 * Disabled rename detection reports every move as a deletion of the old path.
 * That is the path a stale literal holds.
 *
 * Measured on this repository: 11,696 paths over 4,398 commits in 205 ms,
 * against 11,483 for the reading that answers the wrong set.
 */
export async function movedAwayPaths(repoRoot: PathBuilderLike = repoRootPathBuilder): Promise<Set<string>> {
	const lines = await new GitClient({ cwd: repoRoot }).readLines([
		"log",
		"--all",
		"--no-renames",
		"--diff-filter=D",
		"--name-only",
		"--format=",
	])

	return new Set(lines)
}
