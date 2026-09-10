/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Which Bash commands may run, as a pure judgement over the command text. The hook adapter
 *   (`bash-write-guard.ts`) owns the payload and the output JSON; the POLICY lives here so a test can drive it without
 *   spawning a process, and so importing it never reads stdin.
 *
 *   WHAT IT IS FOR. `symbol-precheck.ts` is registered under a `Write|Edit` matcher, so an edit made with a heredoc or
 *   an in-place editor never reaches it: the hook that says where a name already lives cannot fire on a tool it does
 *   not match. An agent editing through Bash writes duplicate helpers with that guard absent.
 *
 *   A SECOND CONCERN LIVES HERE, and it is not about files. A `modal run` is a local client whose death cancels the
 *   remote container, so a launch this shell owns is a training run any signal can destroy. The rules that refuse those
 *   spellings carry their own `guidance`, because the file-write advice is useless to a caller whose run just died.
 *   Adding a rule of a third kind is fine on the same terms: say what to do instead, in the rule.
 *
 *   WHAT IT CANNOT DO, stated because the first version's docstring claimed otherwise. A list of command words cannot
 *   stop a determined write: `node script.js`, `yarn some-script` and a compiled binary all run code this cannot read,
 *   and an admitted program may write whatever it likes. This RAISES THE COST of editing through Bash and makes the
 *   direct spellings fail loudly; it is not a sandbox. Anything that must be impossible belongs in file permissions.
 *
 *   WHY A LIST OF WHAT IS ADMITTED. The refusing version shipped first and refused its own commit within the hour,
 *   because the message quoted an in-place editor in prose. A rule reading the whole command text cannot tell a writer
 *   from a description of one, and a list of forbidden shapes must anticipate every spelling of a write, which the
 *   shell has more of than anyone enumerates.
 *
 *   QUOTED TEXT IS REMOVED BEFORE ANY DECISION, in one pass so the earliest quote wins: a commit message, a search
 *   pattern and a heredoc body are data, and the words inside them are not commands.
 */

import { isAbsolute, resolvePath } from "path-ts"

/**
 * Commands that read, search, build, test, or talk to git, the registry and the services this repository operates. None
 * of them takes file content from the agent as an argument, which is the property that matters: what they write, they
 * derive.
 */
const ADMITTED = new Set([
	// Reading, searching and shell built-ins that answer questions.
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
	// Version control and the forge.
	"gh",
	"git",
	// Toolchain and this repository's own commands.
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
	// The python toolchain, the same shape as `yarn` beside it: `uv run` and `uvx` resolve an
	// environment and run a named tool, deriving the venv they write rather than taking content.
	"uv",
	"uvx",
	"vale",
	"vitest",
	"wrangler",
	"yarn",
])

/**
 * Commands that write wherever their arguments point. Each is admitted only when no path argument lands inside the
 * repository, which is what keeps a scratch directory usable without opening the tree to a shell edit.
 */
const PATH_WRITERS: Readonly<Record<string, "all" | "last">> = {
	chmod: "all",
	// A copy, a move and a link read their first arguments and write only the last.
	cp: "last",
	install: "last",
	ln: "last",
	mkdir: "all",
	mv: "last",
	rm: "all",
	tee: "all",
	touch: "all",
	truncate: "all",
}

/**
 * Commands that run another command. The words after one are re-judged as a command of their own, so a writer cannot
 * hide behind a wrapper.
 */
const WRAPPERS = new Set(["command", "env", "nohup", "time", "timeout", "xargs"])

/**
 * A flag of a wrapper rather than the command it wraps: `timeout 600 yarn test`, `xargs -n1 wc -l`.
 */
const WRAPPER_ARGUMENT = /^(?:-|\d)/u

/**
 * What to do instead of launching a Modal run from Bash, carried by the two rules that need it rather than by
 * {@link GUIDANCE}, which talks about the Write and Edit tools and would be the wrong advice here.
 */
const DETACHED_LAUNCH_GUIDANCE =
	"Launch it through `node packages/mailwoman/lib/dev-tools/launch-detached.run.ts --log <file> -- modal run …`, " +
	"which spawns the client in its own session and exits, so no signal aimed at this shell can reach it. Modal's `-d` " +
	"does not make the client disposable: when the client dies Modal answers `Received a cancellation signal` and stops " +
	"the container mid-training. Watch the run by polling the volume for its next checkpoint, not by holding the client " +
	"open. A run that did die continues with `--resume auto` from its last save."

/**
 * Spellings of an admitted command that this guard refuses. Each is checked against that command's own segment, never
 * against the whole line. Most write a file the agent supplies and take {@link GUIDANCE}; a rule about something else
 * supplies its own `guidance`.
 */
const REFUSED_SPELLINGS: ReadonlyArray<{
	head: string
	pattern: RegExp
	because: string
	guidance?: string
}> = [
	{
		head: "modal",
		// `-d` is the tell that the run is meant to outlive this shell, which is the intent a killable client breaks. A
		// plain `modal run` of a sync or an audit is short and cheap to lose, so it stays admitted.
		pattern: /(?:^|\s)run\b[^\n]*(?:\s-d\b|\s--detach\b)/u,
		because:
			"`modal run -d` from Bash leaves the client in this shell's process group, and killing the client cancels the remote run",
		guidance: DETACHED_LAUNCH_GUIDANCE,
	},
	{
		head: "modal",
		// The 2026-07-15 spelling. `timeout` is a WRAPPER, so it is stripped before the head is read and the head here is
		// `modal`; the segment still carries the wrapper, which is what this matches. Any timed Modal command is refused,
		// not only a launch: the expiry kills the client either way, and a timeout is never how you bound a Modal run.
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
		// The reading forms of these subcommands are ordinary work: `stash list`, `stash show`, and a `checkout` that
		// names a branch rather than a pathspec. Only the spellings that overwrite the working tree are refused.
		pattern: /(?:^|\s)(?:apply\b|restore\b|stash\s+(?!list\b|show\b)|checkout\s+[^\n]*--\s)/u,
		because: "this `git` subcommand overwrites the working tree",
	},
	{ head: "git", pattern: /(?:^|\s)config\s+-f/u, because: "`git config -f` writes an arbitrary file" },
	{ head: "npm", pattern: /(?:^|\s)pkg\s+set\b/u, because: "`npm pkg set` writes a manifest" },
	// The subcommand has to be a WHOLE argument. `\b` ends a word at a hyphen too, so the old pattern read `yarn mwops
	// health node-modules-reacharound` as `yarn node …` and refused a read-only check by its own name.
	{
		head: "yarn",
		pattern: /(?:^|\s)(?:dlx|exec|node)(?=\s|$)/u,
		because: "`yarn` is running an arbitrary program",
	},
	{ head: "npx", pattern: /(?:^|\s)-{1,2}y(?:es)?\b/u, because: "`npx -y` fetches and runs an unreviewed package" },
	{ head: "vitest", pattern: /(?:^|\s)(?:-u\b|--update\b)/u, because: "`vitest -u` rewrites snapshots" },
	// The same tool arrives through the package manager, where `yarn` is the command word.
	{ head: "yarn", pattern: /(?:^|\s)vitest\b[^\n]*(?:\s-u\b|--update\b)/u, because: "`vitest -u` rewrites snapshots" },
	// `oxlint --fix` and `oxfmt --write` are admitted on the same ground as the formatter over its inputs: what they
	// write they derive from the rule set, and no content the agent supplies passes through them. A snapshot update is
	// different in kind — `vitest -u` writes whatever the code under test produced, which is the assertion being replaced.
]

/**
 * An inline script that reaches the filesystem, checked against the interpreter's own segment. A probe printing to
 * stdout is the point of `-e` and `-c`; a write inside one is an edit wearing a probe's clothes.
 */
const INLINE_WRITE =
	/(?:writeFile|appendFile|createWriteStream|openSync|cpSync|renameSync|rmSync|unlinkSync|mkdirSync|execSync|spawnSync|shutil\.|os\.system|subprocess\.)/u

/**
 * An interpreter reading its script from a heredoc. `<<<` is a here-string feeding stdin, which is not a script.
 */
const INTERPRETER_HEREDOC = /<<(?!<)-?\s*['"]?[A-Za-z_]/u

/**
 * A redirect and its target, including `&>` and a numbered descriptor. A descriptor duplication (`2>&1`) names no file
 * and yields no target.
 */
const REDIRECT = /(?:&|\d)?>>?\|?\s*(?:&[\d-]|(?<target>[^\s;|&<>]*))/gu

/**
 * Shell grammar rather than commands. A loop header binds a variable to a word list; the words that open a body are
 * dropped, and whatever follows is judged as a command.
 */
const LOOP_HEADER = /^(?:for|select)\s+\w+\s+in\b/u
const CONTROL_FLOW_WORDS = new Set(["do", "done", "then", "elif", "else", "fi", "esac", "while", "until", "if", "case"])

/**
 * Remove quoted spans and heredoc bodies in ONE pass, so the earliest quote wins. Stripping single quotes before double
 * quotes lets the apostrophe in a word like `don't` pair with a later quote and swallow the command between them.
 */
function withoutQuotedText(command: string): string {
	return (
		command
			.replaceAll(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\t*\2$/gmu, " HEREDOC ")
			// The placeholder keeps the quote's word boundaries: glued where the quote was glued, spaced where it stood
			// alone. Always spacing it would split `PATH="$PWD/bin" node x.ts` into two words and make the head `QUOTED`.
			// `commandSegments` follows the same rule for `${…}`.
			//
			// The prefix must exclude the quote characters. One that can match a quote consumes an opening delimiter, and
			// every quote after it pairs with the wrong partner for the rest of the command.
			.replaceAll(/([^\s'"`]?)(?:'[^']*'|"(?:[^"\\]|\\.)*"|`[^`]*`)/gu, (_match, glued: string) =>
				glued ? `${glued}QUOTED` : " QUOTED "
			)
	)
}

/**
 * Every command word in the text, in order, with wrappers unwrapped and grammar dropped. A command substitution opens a
 * command of its own rather than disappearing.
 */
function commandSegments(stripped: string): Array<{ head: string; segment: string }> {
	const found: Array<{ head: string; segment: string }> = []

	const expanded = stripped
		// A braced expansion collapses to a bare variable rather than to a spaced placeholder, so it stays glued to the
		// word it belongs to: `FOO=${HOME}/data` is one assignment, not an assignment beside a command called `VAR`.
		.replaceAll(/\$\{[^}]*\}/gu, "$VAR")
		// A redirect is not a command, and its `&` is not a separator: `2>&1` must not split into a segment headed by
		// `1`. It is removed rather than replaced, so no placeholder becomes a command word. Targets are judged
		// separately, against the unmasked text.
		.replaceAll(REDIRECT, " ")
		// An opener starts a command of its own; a CLOSER does not end one. Replacing `)` with a separator too would
		// leave `comm -12 <(sort a) b` with a segment headed by `b`, and a filename is not a command.
		.replaceAll(/\$\(|<\(|\(|\{|\}/gu, " ; ")
		.replaceAll(")", " ")

	for (const rawSegment of expanded.split(/(?:&&|\|\||[;|&\n])/u)) {
		const segment = rawSegment.trim()

		// A loop header binds a name to a word list; the list is data, and the body follows the next separator.
		if (!segment || LOOP_HEADER.test(segment)) continue

		let words = segment.split(/\s+/u).filter((word) => word.length > 0)

		// Leading assignments, a negation, and the words that open a body all precede the command.
		while (
			words.length &&
			(/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[0]!) || words[0] === "!" || CONTROL_FLOW_WORDS.has(words[0]!))
		) {
			words = words.slice(1)
		}

		// A wrapper runs the command after its own flags, so judge that instead.
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
 * Where a relative path resolves, following any `cd` the command performs first.
 */
function workingDirectory(stripped: string, cwd: string): string {
	const match = stripped.match(/(?:^|[;&|]\s*)cd\s+(?<target>[^\s;|&]+)/u)
	const target = match?.groups?.["target"]

	if (!target || target.includes("$")) return cwd

	return isAbsolute(target) ? target : String(resolvePath(cwd, target))
}

/**
 * `~` is the shell's, not a path segment. It is read from the raw environment rather than through the typed view
 * because this module is loaded by a hook that must answer in milliseconds and must not fail when a variable is unset:
 * an absent `HOME` leaves the path unexpanded, which then reads as relative and resolves under the repository — the
 * refusing direction.
 */
// oxlint-disable-next-line sister-software/no-process-globals -- see above.
const HOME_DIRECTORY = process.env["HOME"] ?? ""

function expandHome(path: string): string {
	return path.startsWith("~") ? `${HOME_DIRECTORY}${path.slice(1)}` : path
}

/**
 * True when a path lands inside the repository. A path this cannot read — one carrying a variable, or a quoted span
 * already stripped — counts as inside: an unknown target is the case a guard must not wave through.
 */
function insideRepository(raw: string, repoRoot: string, cwd: string): boolean {
	if (!raw || raw.startsWith("/dev/")) return false

	// A stripped quote and a variable are both unreadable here, and an unreadable target counts as inside.
	if (raw === "QUOTED" || raw === "HEREDOC" || raw.includes("$")) return true

	const expanded = expandHome(raw)
	const resolved = isAbsolute(expanded) ? expanded : String(resolvePath(cwd, expanded))

	return resolved === repoRoot || resolved.startsWith(`${repoRoot}/`)
}

/**
 * A refusal: why the command is refused, and what to do instead.
 *
 * Most refusals are about writing a file and take {@link GUIDANCE}. A rule about something else — process ownership, say
 * — carries its own `guidance`, because being told to use the Write tool over a cancelled training run is advice for a
 * problem the caller does not have.
 */
export interface CommandRefusal {
	reason: string
	guidance: string
}

/**
 * Why a command is refused, or `null` when every part of it is admitted.
 *
 * @param command The Bash command as written.
 * @param repoRoot The repository this guards, absolute and without a trailing separator.
 * @param sessionCwd Where a relative path resolves before any `cd` in the command itself.
 */
export function judgeCommand(command: string, repoRoot: string, sessionCwd: string): CommandRefusal | null {
	const stripped = withoutQuotedText(command)
	const cwd = workingDirectory(stripped, sessionCwd)
	const segments = commandSegments(stripped)

	// An inline script and a heredoc body both live inside the quoting stripped above, so these two read the RAW
	// command. Requiring an interpreter first is what stops `grep -rn writeFile packages` from refusing itself.
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

			if (targets.some((target) => insideRepository(target, repoRoot, cwd))) {
				return refuse(`\`${head}\` writes inside the repository.`)
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
 * A refusal carrying {@link GUIDANCE} unless the rule supplied advice of its own.
 */
function refuse(reason: string, guidance?: string): CommandRefusal {
	return { reason, guidance: guidance ?? GUIDANCE }
}

/**
 * What to do instead, appended to every refusal.
 */
export const GUIDANCE =
	"Use the Edit tool for a change to an existing file and the Write tool for a new one. Those tools carry the " +
	"symbol precheck, which names an existing home before a duplicate is written; a Bash edit skips it. Reading, " +
	"searching, git, the toolchain and a file written outside the repository are all admitted — the admitted list is " +
	"`ADMITTED` in packages/dev-mcp/lib/hooks/bash-write-rules.ts, and adding a command there is a normal change. A " +
	"redirect target this hook cannot read, such as one behind a variable, counts as inside the repository; name the " +
	"path in full."
