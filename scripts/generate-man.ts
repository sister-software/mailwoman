/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generate `mailwoman/man/mailwoman.1` from the CLI's OWN help tree (#1577's `man mailwoman`
 *   item). The command descriptions already live once, in each command module — a hand-written man
 *   page would be a second copy of every sentence, stale by the first help edit, so this derives
 *   the page instead: root help supplies NAME/SYNOPSIS/COMMANDS, each user-facing command's
 *   `--help` supplies its own section. npm links `package.json#man` on a global install, which is
 *   what makes `man mailwoman` answer.
 *
 *   Committed-artifact discipline: the page is generated INTO the tree and committed
 *   (`mailwoman/test/man-page.test.ts` re-renders and fails on drift), matching the
 *   sentencepiece-wasm single-file-ESM precedent — consumers get the artifact, CI proves it fresh.
 *
 *   Run: `node scripts/generate-man.ts` (after `yarn compile` — it spawns the COMPILED CLI, the
 *   same binary consumers run).
 */

import { makeDirectories, writeLocalFile } from "@mailwoman/core/fs/writers"
import { runFile } from "@mailwoman/core/process"
import { runIfScript } from "@mailwoman/core/scripting"
import { repoRootPath } from "@mailwoman/core/utils"
import { dirname, resolvePath } from "path-ts"

const REPO_ROOT = repoRootPath()

/**
 * The committed artifact this script maintains — also read by the freshness test.
 */
export const MAN_PAGE_PATH = resolvePath(REPO_ROOT, "packages/mailwoman/man/mailwoman.1")

/**
 * The compiled CLI the page derives from — the same binary consumers run.
 */
export const CLI_PATH = resolvePath(REPO_ROOT, "packages/mailwoman/out/cli.js")

/**
 * The user-facing commands a man reader cares about. `dev`, `clients`, and the model-work groups (`corpus`, `eval`,
 * `gazetteer`, `release`, `coverage`, `tiles`) are maintainer surfaces — their help stays available via `--help`;
 * putting every internal group in the manual buries the six commands an installer actually runs.
 */
const USER_COMMANDS = ["parse", "geocode", "autocomplete", "doctor", "data", "serve"] as const

async function help(cliPath: string, args: string[]): Promise<string> {
	return (await runFile("node", [cliPath, ...args, "--help"])).stdout
}

/**
 * Escape troff-significant characters. Leading dots/quotes control troff; hyphens in option names must be literal `\-`
 * so `man` renders ASCII hyphens (grep-able flags).
 */
function troffEscape(line: string): string {
	const escaped = line.replaceAll("\\", "\\\\").replaceAll("-", "\\-")

	return /^[.']/.test(escaped) ? `\\&${escaped}` : escaped
}

/**
 * A help screen as preformatted man content — the CLI's own layout is already column-aligned, so the manual preserves
 * it verbatim inside a no-fill block rather than re-flowing it.
 */
function preformatted(text: string): string {
	// oxlint-disable-next-line mailwoman/prefer-spliterator -- a help screen is a few dozen bounded lines
	const lines = text
		.replace(/\s+$/, "")
		.split("\n")
		.map((line) => troffEscape(line.trimEnd()))

	return [".nf", ...lines, ".fi"].join("\n")
}

/**
 * Render the whole page from a CLI binary's help tree. Pure with respect to the filesystem — the write happens only in
 * the script entrypoint below, so the freshness test can render and compare without touching the tree.
 */
export async function renderManPage(cliPath: string = CLI_PATH): Promise<string> {
	const version = (await runFile("node", [cliPath, "--version"])).stdout.trim()

	const sections: string[] = [
		// No date field on purpose: the page regenerates from the help tree, and a wall-clock stamp
		// would make the freshness test fail on every calendar day rather than on real drift.
		`.TH MAILWOMAN 1 "" "mailwoman ${version}" "User Commands"`,
		".SH NAME",
		"mailwoman \\- calibrated, retrieval\\-augmented postal\\-address parser and geocoder",
		".SH SYNOPSIS",
		".B mailwoman",
		"[command] [options]",
		".br",
		".B mw",
		"[command] [options]",
		".SH DESCRIPTION",
		"Parse postal addresses into labeled components, geocode them against local sealed",
		"data artifacts, and manage the reference databases those lookups read. The",
		".B mw",
		"binary is an alias for",
		".BR mailwoman .",
		"Every command answers",
		".B \\-\\-help",
		"with more detail than this page; the sections below cover the commands an installer",
		"runs directly. Maintainer surfaces (corpus, eval, gazetteer, release) are documented",
		"in the repository.",
		".SH COMMANDS",
		preformatted(await help(cliPath, [])),
	]

	for (const command of USER_COMMANDS) {
		try {
			sections.push(`.SH ${command.toUpperCase()}`, preformatted(await help(cliPath, [command])))
		} catch {
			// A command absent from this build simply gets no section.
		}
	}

	sections.push(
		".SH ENVIRONMENT",
		".TP",
		".B MAILWOMAN_DATA_ROOT",
		"Root directory for the reference data artifacts (candidate gazetteer, POI layer,",
		"street shards). Defaults to a platform data directory; `mailwoman doctor \\-\\-verbose`",
		"prints every resolved path.",
		".SH SEE ALSO",
		"Project documentation: https://mailwoman.ai",
		".br",
		"Issues: https://github.com/sister-software/mailwoman"
	)

	return sections.join("\n") + "\n"
}

runIfScript(import.meta, async () => {
	const page = await renderManPage()

	await makeDirectories(dirname(MAN_PAGE_PATH))
	await writeLocalFile(page, MAN_PAGE_PATH)

	console.log(`wrote ${MAN_PAGE_PATH}`)
})
