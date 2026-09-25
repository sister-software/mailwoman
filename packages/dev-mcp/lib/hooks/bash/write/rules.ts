/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Decides from the command text alone whether a Bash command may run.
 *
 *   The symbol precheck hook runs only on the Write and Edit tools, so this guard steers file edits
 *   away from Bash. It also refuses Modal launches that a shell signal could cancel. The guard is an
 *   allowlist because the shell has too many ways to spell a write for a denylist to cover. It does
 *   not sandbox anything: an admitted program such as `node script.js` can still write any file.
 *
 *   Quoted text and heredoc bodies are removed before any decision, because their words are data.
 */

import { isAbsolute, resolvePath } from "path-ts"

/**
 * Commands that may run anywhere.
 *
 * None of them takes file content from the agent as an argument.
 * Anything they write, they derive.
 */
const ADMITTED = new Set([
	"awk",
	"basename",
	"cat",
	"column",
	"comm",
	"date",
	"diff",
	"dirname",
	"du",
	"echo",
	"false",
	"file",
	"find",
	"grep",
	"head",
	"jq",
	"ls",
	"paste",
	"pgrep",
	"printf",
	"ps",
	"pwd",
	"readlink",
	"realpath",
	"rg",
	"sed",
	"seq",
	"set",
	"sha256sum",
	"sleep",
	"sort",
	"stat",
	"tac",
	"tail",
	"test",
	"tr",
	"tree",
	"true",
	"uniq",
	"wc",
	"which",
	"xxd",
	"gh",
	"git",
	// `mkdir` creates no file content and cannot overwrite a file, and git does not track an empty directory.
	"mkdir",
	"docker",
	"duckdb",
	"hf",
	"mailwoman",
	"modal",
	"mw",
	"mwops",
	"node",
	"npm",
	"npx",
	"ogrinfo",
	"oxfmt",
	"oxlint",
	"python",
	"python3",
	"rclone",
	"sqlite3",
	"tar",
	"tsc",
	"uv",
	"uvx",
	"vale",
	"vitest",
	"wrangler",
	"yarn",
])

/**
 * Commands that write to the paths in their arguments.
 *
 * Each is admitted only when no written path lands inside the repository.
 * The value says whether every operand is written or only the last one.
 */
const PATH_WRITERS: Readonly<Record<string, "all" | "last">> = {
	chmod: "all",
	cp: "last",
	install: "last",
	ln: "last",
	mv: "last",
	rm: "all",
	tee: "all",
	touch: "all",
	truncate: "all",
}

/**
 * Repository paths that hold only derived files: compiler output and installed dependencies.
 *
 * No tracked path matches, and `tsc -b` or `yarn install` restores any of them.
 * `.yarn/` is excluded because it holds the tracked yarn binary.
 *
 * Only {@link REMOVER} gets this exemption.
 * Removing derived output is safe, but a hand-written file such as `out/<subpath>.d.ts`
 * would stand in for source that does not exist.
 */
const DERIVED_PATH = /(?:^|\/)(?:out|dist|node_modules)(?:\/|$)|\.tsbuildinfo$/u

const REMOVER = "rm"

/**
 * Commands that run another command.
 * The guard judges the wrapped command instead.
 */
const WRAPPERS = new Set(["command", "env", "nohup", "time", "timeout", "xargs"])

/**
 * Matches a wrapper's own argument, such as `600` in `timeout 600 yarn test` or `-n1` in `xargs -n1 wc -l`.
 */
const WRAPPER_ARGUMENT = /^(?:-|\d)/u

/**
 * The advice for the two Modal launch refusals.
 */
const DETACHED_LAUNCH_GUIDANCE =
	"Launch it through `node packages/mailwoman/lib/dev-tools/launch-detached.run.ts --log <file> -- modal run …`, " +
	"which spawns the client in its own session and exits, so no signal aimed at this shell can reach it. Modal's `-d` " +
	"does not make the client disposable: when the client dies Modal answers `Received a cancellation signal` and stops " +
	"the container mid-training. Watch the run by polling the volume for its next checkpoint rather than by holding the client " +
	"open. A run that did die continues with `--resume auto` from its last save."

/**
 * The advice for a {@link REMOVER} refusal.
 */
const REMOVAL_GUIDANCE =
	"Removing DERIVED output is admitted: a path under `out/`, `dist/` or `node_modules/`, or a `*.tsbuildinfo`, read " +
	"after any `..` is resolved. Anything else inside the repository is tracked or is someone's scratch file — remove a " +
	"tracked path with `git rm`, so the index and the worktree agree. A target this hook cannot read, such as one behind " +
	"a variable, is never derived; name the path in full."

/**
 * Forms of an admitted command that the guard refuses.
 *
 * Each pattern is tested against that command's own segment.
 * A rule without `guidance` uses {@link GUIDANCE}.
 */
const REFUSED_SPELLINGS: ReadonlyArray<{
	head: string
	pattern: RegExp
	because: string
	guidance?: string
}> = [
	{
		head: "modal",
		// `-d` marks a run meant to outlive the shell.
		// A short `modal run` without it stays admitted.
		pattern: /(?:^|\s)run\b[^\n]*(?:\s-d\b|\s--detach\b)/u,
		because:
			"`modal run -d` from Bash leaves the client in this shell's process group, and killing the client cancels the remote run",
		guidance: DETACHED_LAUNCH_GUIDANCE,
	},
	{
		head: "modal",
		// The head skips the `timeout` wrapper, but the segment still starts with it.
		// Every timed Modal command is refused, because the expiry kills the client.
		pattern: /^\s*timeout\b/u,
		because: "a shell `timeout` kills the `modal` client when it expires, which cancels whatever it was running",
		guidance: DETACHED_LAUNCH_GUIDANCE,
	},
	{ head: "sed", pattern: /(?:^|\s)(?:-[a-zA-Z]*i|--in-place)/u, because: "`sed` in place edits a file" },
	{ head: "sort", pattern: /(?:^|\s)(?:-[a-zA-Z]*o\b|--output)/u, because: "`sort` with an output flag overwrites" },
	{ head: "awk", pattern: /(?:^|\s)-i\s+inplace/u, because: "`awk -i inplace` edits a file" },
	{
		head: "find",
		pattern: /(?:^|\s)-(?:exec|execdir|delete)\b/u,
		because: "`find` is running a command over its hits",
	},
	{
		head: "git",
		// Only forms that overwrite the working tree are refused.
		// `stash list`, `stash show` and a branch `checkout` stay admitted.
		//
		// `git stash drop` is admitted only with an explicit `stash@{N}`.
		// The stash stack is shared by every worktree, so a bare drop could remove another session's entry.
		//
		// `git apply` stays admitted.
		// A patch fails instead of overwriting when its context does not match,
		// and it can land a large mechanical change exactly.
		pattern: /(?:^|\s)(?:restore\b|stash\s+(?!list\b|show\b|drop\s+stash@\{\d+\}\s*$)|checkout\s+[^\n]*--\s)/u,
		because: "this `git` subcommand overwrites the working tree",
	},
	{ head: "git", pattern: /(?:^|\s)config\s+-f/u, because: "`git config -f` writes an arbitrary file" },
	{ head: "npm", pattern: /(?:^|\s)pkg\s+set\b/u, because: "`npm pkg set` writes a manifest" },
	// The subcommand must be a whole argument.
	// A `\b` boundary would also match `node-modules-…`.
	{
		head: "yarn",
		pattern: /(?:^|\s)(?:dlx|exec|node)(?=\s|$)/u,
		because: "`yarn` is running an arbitrary program",
	},
	{ head: "npx", pattern: /(?:^|\s)-{1,2}y(?:es)?\b/u, because: "`npx -y` fetches and runs an unreviewed package" },
	{ head: "vitest", pattern: /(?:^|\s)(?:-u\b|--update\b)/u, because: "`vitest -u` rewrites snapshots" },
	{ head: "yarn", pattern: /(?:^|\s)vitest\b[^\n]*(?:\s-u\b|--update\b)/u, because: "`vitest -u` rewrites snapshots" },
	// `oxlint --fix` and `oxfmt --write` stay admitted because they derive their output from the rules.
	// A snapshot update is refused because it replaces the assertion with whatever the code produced.
]

/**
 * Matches an inline script call that reaches the filesystem or spawns a process.
 *
 * An inline `-e` or `-c` script may print, but a write inside one counts as an edit.
 */
const INLINE_WRITE =
	/(?:writeFile|appendFile|createWriteStream|openSync|cpSync|renameSync|rmSync|unlinkSync|mkdirSync|execSync|spawnSync|shutil\.|os\.system|subprocess\.)/u

/**
 * Matches a heredoc that feeds an interpreter its script.
 *
 * The pattern excludes `<<<`, which is a here-string.
 */
const INTERPRETER_HEREDOC = /<<(?!<)-?\s*['"]?[A-Za-z_]/u

/**
 * Matches a redirect and its target, including `&>` and a numbered descriptor.
 *
 * A descriptor duplication such as `2>&1` yields no target.
 */
const REDIRECT = /(?:&|\d)?>>?\|?\s*(?:&[\d-]|(?<target>[^\s;|&<>]*))/gu

/**
 * Shell grammar words that precede a command.
 *
 * A loop header's word list is data.
 * The guard drops body keywords and judges the word after them.
 */
const LOOP_HEADER = /^(?:for|select)\s+\w+\s+in\b/u
const CONTROL_FLOW_WORDS = new Set(["do", "done", "then", "elif", "else", "fi", "esac", "while", "until", "if", "case"])

/**
 * Replaces heredoc bodies and quoted spans with placeholders.
 *
 * All three quote kinds are matched in one pass so the earliest quote wins.
 * Separate passes would
 * let the apostrophe in `don't` pair with a later quote.
 */
function withoutQuotedText(command: string): string {
	return (
		command
			.replaceAll(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\t*\2$/gmu, " HEREDOC ")
			// A placeholder stays glued to a preceding character, so `path="$PWD/bin" node x.ts` keeps
			// one assignment word. The glued character must not be a quote, or it would consume an
			// opening delimiter and mispair every later quote.
			.replaceAll(/([^\s'"`]?)(?:'[^']*'|"(?:[^"\\]|\\.)*"|`[^`]*`)/gu, (_match, glued: string) =>
				glued ? `${glued}QUOTED` : " QUOTED "
			)
	)
}

/**
 * Returns each command in the text with its head word, after unwrapping wrappers and dropping grammar.
 *
 * A command substitution becomes a command of its own.
 */
function commandSegments(stripped: string): Array<{ head: string; segment: string }> {
	const found: Array<{ head: string; segment: string }> = []

	const expanded = stripped
		// A braced expansion stays glued to its word, so `FOO=${home}/data` remains one assignment.
		.replaceAll(/\$\{[^}]*\}/gu, "$VAR")
		// Redirects are removed so `2>&1` does not split on `&`. Their targets are checked later
		// against the unmasked text.
		.replaceAll(REDIRECT, " ")
		// An opener starts a new command, and a closer does not. Otherwise `comm -12 <(sort a) b`
		// would produce a segment headed by the filename `b`.
		//
		// A brace opens a group only when whitespace follows it, and closes one only after whitespace
		// or a separator, as in bash. A brace glued to a word, as in `stash@{0}`, belongs to that word.
		.replaceAll(/\$\(|<\(|\(|\{(?=\s|$)|(?<=^|\s)\}/gu, " ; ")
		.replaceAll(")", " ")

	for (const rawSegment of expanded.split(/(?:&&|\|\||[;|&\n])/u)) {
		const segment = rawSegment.trim()

		// A loop header's word list is data.
		// The loop body starts after the next separator.
		if (!segment || LOOP_HEADER.test(segment)) continue

		let words = segment.split(/\s+/u).filter((word) => word.length)

		// Leading assignments, `!` and control-flow keywords precede the command word.
		while (
			words.length &&
			(/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[0]!) || words[0] === "!" || CONTROL_FLOW_WORDS.has(words[0]!))
		) {
			words = words.slice(1)
		}

		// A wrapper runs the command that follows its own arguments.
		while (words.length && WRAPPERS.has(words[0]!.replace(/^.*\//u, ""))) {
			words = words.slice(1)

			while (words.length && WRAPPER_ARGUMENT.test(words[0]!)) {
				words = words.slice(1)
			}
		}

		const head = words[0]

		if (!head || head.startsWith("-") || head.startsWith(">") || head.startsWith("<")) continue

		found.push({ head: head.replace(/^.*\//u, ""), segment })
	}

	return found
}

/**
 * Returns the directory that relative paths resolve against, following the first literal `cd`.
 */
function workingDirectory(stripped: string, cwd: string): string {
	const match = stripped.match(/(?:^|[;&|]\s*)cd\s+(?<target>[^\s;|&]+)/u)
	const target = match?.groups?.["target"]

	if (!target || target.includes("$")) return cwd

	return isAbsolute(target) ? target : resolvePath(cwd, target)
}

/**
 * The home directory that `~` expands to.
 *
 * The hook must answer fast and never fail on an unset variable, so this reads `process.env` directly.
 */
// oxlint-disable-next-line sister-software/no-process-globals -- see above.
const HOME_DIRECTORY = process.env["HOME"] ?? ""

function expandHome(path: string): string {
	return path.startsWith("~") ? `${HOME_DIRECTORY}${path.slice(1)}` : path
}

/**
 * Returns the absolute path of a target, or null when the target is a placeholder or a variable.
 *
 * `resolvePath` normalizes `..`, so `out/../lib` does not count as derived output.
 */
function resolveTarget(raw: string, cwd: string): string | null {
	if (!raw || raw === "QUOTED" || raw === "HEREDOC" || raw.includes("$")) return null

	const expanded = expandHome(raw)

	return isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded)
}

/**
 * Returns true when a path lands inside the repository.
 *
 * An unreadable target counts as inside, so the guard refuses it.
 */
function insideRepository(raw: string, repoRoot: string, cwd: string): boolean {
	if (!raw || raw.startsWith("/dev/")) return false

	const resolved = resolveTarget(raw, cwd)

	if (resolved === null) return true

	return resolved === repoRoot || resolved.startsWith(`${repoRoot}/`)
}

/**
 * Returns true when a path matches {@link DERIVED_PATH}.
 *
 * An unreadable target never counts as derived.
 */
function isDerivedPath(raw: string, cwd: string): boolean {
	const resolved = resolveTarget(raw, cwd)

	return resolved !== null && DERIVED_PATH.test(resolved)
}

/**
 * A refusal with its reason and the advice on what to do instead.
 */
export interface CommandRefusal {
	reason: string
	guidance: string
}

/**
 * Returns the refusal for a command, or `null` when every part of it is admitted.
 *
 * @param command The Bash command as written.
 * @param repoRoot The absolute repository path, without a trailing separator.
 * @param sessionCwd The directory that relative paths resolve against before any `cd` in the command.
 */
export function judgeCommand(command: string, repoRoot: string, sessionCwd: string): CommandRefusal | null {
	const stripped = withoutQuotedText(command)
	const cwd = workingDirectory(stripped, sessionCwd)
	const segments = commandSegments(stripped)

	// Inline scripts and heredoc bodies were stripped above, so these checks read the raw command.
	// They apply only when an interpreter runs, so `grep -rn writeFile packages` stays admitted.
	if (segments.some(({ head }) => head === "node" || head.startsWith("python"))) {
		if (INTERPRETER_HEREDOC.test(command)) {
			return refuse("This runs a script from a heredoc, which rewrites a file whole.")
		}

		if (INLINE_WRITE.test(command)) return refuse("This inline script reaches the filesystem.")
	}

	for (const { head, segment } of segments) {
		if (head === "cd") continue

		for (const { head: refusedHead, pattern, because, guidance } of REFUSED_SPELLINGS) {
			if (head === refusedHead && pattern.test(segment)) return refuse(`${because}.`, guidance)
		}

		const writes = PATH_WRITERS[head]

		if (writes) {
			const operands = segment
				.split(/\s+/u)
				.slice(1)
				.filter((word) => word.length > 0 && !word.startsWith("-"))

			const targets = writes === "last" ? operands.slice(-1) : operands
			const guarded = head === REMOVER ? targets.filter((target) => !isDerivedPath(target, cwd)) : targets

			if (guarded.some((target) => insideRepository(target, repoRoot, cwd))) {
				return head === REMOVER
					? refuse("`rm` removes a repository path that is not derived output.", REMOVAL_GUIDANCE)
					: refuse(`\`${head}\` writes inside the repository.`)
			}

			continue
		}

		if (!ADMITTED.has(head)) return refuse(`\`${head}\` is not on the admitted command list.`)
	}

	for (const match of stripped.matchAll(REDIRECT)) {
		if (insideRepository(match.groups?.["target"] ?? "", repoRoot, cwd)) {
			return refuse("This redirects output into a file inside the repository.")
		}
	}

	return null
}

/**
 * Builds a refusal that uses {@link GUIDANCE} unless the rule supplies its own advice.
 */
function refuse(reason: string, guidance?: string): CommandRefusal {
	return { reason, guidance: guidance ?? GUIDANCE }
}

/**
 * The default advice attached to a refusal.
 */
export const GUIDANCE =
	"Use the Edit tool for a change to an existing file and the Write tool for a new one. Those tools carry the " +
	"symbol precheck, which names an existing home before a duplicate is written; a Bash edit skips it. Reading, " +
	"searching, git, the toolchain and a file written outside the repository are all admitted — the admitted list is " +
	"`ADMITTED` in packages/dev-mcp/lib/hooks/bash/write/rules.ts, and adding a command there is a normal change. A " +
	"redirect target this hook cannot read, such as one behind a variable, counts as inside the repository; name the " +
	"path in full."
