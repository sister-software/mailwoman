#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   PreToolUse hook: admit a Bash command only when every segment's command is on the list below, so a file edit goes
 *   through the Write and Edit tools and reaches the symbol precheck.
 *
 *   WHY A LIST OF WHAT IS ADMITTED, rather than of what is refused. The refusing version of this hook shipped first and
 *   refused its own commit inside the hour: the commit message quoted `sed -i` in prose, and a rule that reads the
 *   whole command text cannot tell a writer from a description of one. A pattern of forbidden shapes also has to
 *   anticipate every spelling of a write, and the shell has more of them than anyone lists. The admitted set is small,
 *   nameable, and fails toward asking rather than toward a silent edit.
 *
 *   WHAT THIS PROTECTS. `symbol-precheck.ts` is registered under a `Write|Edit` matcher, so an edit made with a
 *   heredoc or `sed -i` never reaches it: the hook that says where a name already lives cannot fire on a tool it does
 *   not match. An agent editing through Bash writes duplicate helpers with that guard silently absent, which is what
 *   happened across a session on 2026-09-07.
 *
 *   QUOTED TEXT IS REMOVED BEFORE ANY DECISION. A commit message, a `grep` pattern and a heredoc body are data; the
 *   words inside them are not commands. Stripping them is what makes `git commit -m "... sed -i ..."` admissible
 *   without admitting `sed -i`.
 *
 *   Two conditions survive that stripping, because both name a shape rather than a word. An admitted interpreter is
 *   refused when it runs a heredoc or when an inline script reaches the filesystem, and any admitted command is
 *   refused when it redirects into the repository. Capturing a log outside the tree stays legal, because a long run is
 *   read back from its log and refusing that would trade one defect for a worse one.
 */

import { readStandardInputJSON } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/paths"
import { isAbsolute, resolvePath } from "path-ts"

/**
 * Commands that read, search, build, test, or talk to git and the registry. None of them takes file content from the
 * agent, which is the property that matters: what they write, they derive.
 */
const ADMITTED = new Set([
	// Reading and searching.
	"awk",
	"basename",
	"cat",
	"date",
	"diff",
	"dirname",
	"du",
	"echo",
	"env",
	"file",
	"find",
	"grep",
	"head",
	"jq",
	"ls",
	"printf",
	"pwd",
	"readlink",
	"realpath",
	"rg",
	"sort",
	"stat",
	"tail",
	"test",
	"tr",
	"true",
	"uniq",
	"wc",
	"which",
	"xargs",
	// Version control and the forge.
	"gh",
	"git",
	// Toolchain. `node` and `python` carry the inline-write condition below.
	"node",
	"npm",
	"npx",
	"oxfmt",
	"oxlint",
	"python",
	"python3",
	"tsc",
	"vitest",
	"yarn",
])

/**
 * `sed` and `sort` write when given a flag, and read otherwise. Rather than admit the command and hunt the flag, each
 * is admitted only in its reading spelling.
 */
const CONDITIONAL_HEADS: Readonly<Record<string, { readonly refuse: RegExp; readonly because: string }>> = {
	sed: { refuse: /(?:^|\s)-[a-zA-Z]*i/u, because: "`sed -i` edits in place" },
	sort: { refuse: /(?:^|\s)-o\b/u, because: "`sort -o` writes its output over a file" },
}

/**
 * An inline script that reaches the filesystem. A probe printing to stdout is the point of `-e` and `-c` and stays
 * admitted; a write inside one is an edit wearing a probe's clothes.
 *
 * This one reads the RAW command, quotes included, because an inline script lives inside them. That is the opposite of
 * every other rule here and it is the correct exception: `-e` and `-c` take code, not prose, so there is no message
 * body to mistake for a command. It applies only when the command word is an interpreter.
 */
const INLINE_WRITE =
	/(?:writeFile|appendFile|createWriteStream|\.write\(|open\([^)]*,\s*['"][wa]|Path\([^)]*\)\.write)/u

/**
 * An interpreter reading a script from a heredoc — `python3 - <<'PY'`. The body is stripped before every other
 * decision, so this looks for the redirection itself rather than for what it carries.
 */
const INTERPRETER_HEREDOC = /\b(?:node|python3?|ruby)\b[^\n;|&]*<<-?\s*['"]?[A-Za-z_]/u

/**
 * A redirect and its target. `/dev/null` and a descriptor duplication (`2>&1`) name no file.
 */
const REDIRECT = /(?<!\d)(?<!&)>>?\s*(?!&)(?<target>[^\s;|&<>]+)/gu

/**
 * Shell grammar, not commands. A loop header names a variable and a word list, so the whole segment is skipped; the
 * words that introduce a body are dropped and the command after them is judged on its own.
 */
const CONTROL_FLOW_SEGMENTS = new Set(["for", "while", "until", "if", "case", "select"])
const CONTROL_FLOW_WORDS = new Set(["do", "done", "then", "elif", "else", "fi", "esac", "time"])

/**
 * Remove quoted spans and heredoc bodies, so their contents are never read as commands. A commit message that describes
 * a writer, a `grep` pattern that contains one, and a heredoc that carries source are all data.
 */
function withoutQuotedText(command: string): string {
	return command
		.replaceAll(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\t*\2$/gmu, " HEREDOC ")
		.replaceAll(/'[^']*'/gu, " ")
		.replaceAll(/"(?:[^"\\]|\\.)*"/gu, " ")
		.replaceAll(/`[^`]*`/gu, " ")
}

/**
 * The command word of each segment, with leading environment assignments, grouping tokens and redirections dropped. An
 * empty segment yields nothing, which is how a trailing operator or a lone `}` disappears.
 */
function commandHeads(stripped: string): Array<{ head: string; segment: string }> {
	const heads: Array<{ head: string; segment: string }> = []

	for (const rawSegment of stripped.split(/(?:&&|\|\||[;|\n])/u)) {
		const segment = rawSegment.replaceAll(/[{}()]/gu, " ").trim()

		if (!segment) continue

		const words = segment.split(/\s+/u).filter((word) => word.length > 0)

		// A loop or conditional header carries a variable and a word list, neither of which is a command.
		if (CONTROL_FLOW_SEGMENTS.has(words[0] ?? "")) continue

		let index = 0

		// Environment assignments, a subshell's `!`, and the words that open a body all precede the command word.
		while (
			index < words.length &&
			(/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[index]!) || words[index] === "!" || CONTROL_FLOW_WORDS.has(words[index]!))
		) {
			index += 1
		}

		const head = words[index]

		if (!head || head.startsWith("-") || head.startsWith(">")) continue

		heads.push({ head: head.replace(/^.*\//u, ""), segment })
	}

	return heads
}

/**
 * True when a redirect target lands inside the repository. A relative target resolves against `cwd`; a target under a
 * temporary directory is outside by construction and stays admitted.
 */
function redirectsIntoRepository(stripped: string, repoRoot: string, cwd: string): boolean {
	for (const match of stripped.matchAll(REDIRECT)) {
		const raw = match.groups?.["target"] ?? ""

		if (!raw || raw.startsWith("/dev/")) continue

		// An unexpanded variable names no path this hook can read.
		if (raw.includes("$")) continue

		const resolved = isAbsolute(raw) ? raw : String(resolvePath(cwd, raw))

		if (resolved.startsWith(`${repoRoot}/`)) return true
	}

	return false
}

const GUIDANCE =
	"Use the Edit tool for a change to an existing file and the Write tool for a new one. Those tools carry the " +
	"symbol precheck, which names an existing home before a duplicate is written; a Bash edit skips it. Reading, " +
	"searching, git, the toolchain and a log written outside the repository are all admitted — the admitted list is " +
	"`ADMITTED` in packages/dev-mcp/lib/hooks/bash-write-guard.ts, and adding a command there is a normal change."

function refusal(reason: string): string {
	return JSON.stringify({
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: `${reason} ${GUIDANCE}`,
		},
	})
}

async function main(): Promise<void> {
	const payload = await readStandardInputJSON<Record<string, unknown>>().catch(() => null)

	if (!payload || payload["tool_name"] !== "Bash") return

	const input = payload["tool_input"]
	const command = typeof input === "object" && input !== null ? (input as { command?: unknown }).command : undefined

	if (typeof command !== "string" || !command.trim()) return

	// The repository this hook ships in, located from the hook's own file rather than from an environment variable the
	// harness sets: a session started in a subdirectory still guards the same tree.
	const repoRoot = String(repoRootPath()).replace(/\/$/u, "")
	const cwd = typeof payload["cwd"] === "string" ? payload["cwd"] : repoRoot
	const stripped = withoutQuotedText(command)

	for (const { head, segment } of commandHeads(stripped)) {
		if (head === "cd") continue

		const conditional = CONDITIONAL_HEADS[head]

		if (conditional) {
			if (conditional.refuse.test(segment)) {
				process.stdout.write(refusal(`${conditional.because}.`))

				return
			}

			continue
		}

		if (!ADMITTED.has(head)) {
			process.stdout.write(refusal(`\`${head}\` is not on the admitted command list.`))

			return
		}

		// An interpreter is admitted for probes that print. The two shapes that make one an editor are read from the raw
		// command, because both live inside the quoting this hook otherwise discards.
		if (head === "node" || head.startsWith("python")) {
			if (INTERPRETER_HEREDOC.test(command)) {
				process.stdout.write(refusal("This runs a script from a heredoc, which is how a file gets rewritten whole."))

				return
			}

			if (INLINE_WRITE.test(command)) {
				process.stdout.write(refusal("This inline script writes a file."))

				return
			}
		}
	}

	if (redirectsIntoRepository(stripped, repoRoot, cwd)) {
		process.stdout.write(refusal("This command redirects output into a file inside the repository."))
	}
}

try {
	await main()
} catch {
	// A guard that throws on an unanticipated payload is a broken shell rather than a missing refusal, so an
	// unreadable payload is admitted — the same contract `symbol-precheck.ts` states in its header.
}
