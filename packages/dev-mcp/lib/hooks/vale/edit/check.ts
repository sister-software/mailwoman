#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Claude Code PostToolUse hook: run the file an Edit or Write just changed through the same Vale surface CI runs,
 *   and hand any findings straight back.
 *
 *   Without it the findings arrive at `yarn lint`, minutes later and several edits on, and the whole preflight is spent
 *   to learn that a comment carries a semicolon. Four consecutive preflights in one session ended that way, each costing
 *   a full `format && lint && compile && test` cycle to report one comment.
 *
 *   The surface follows the extension, and both are the ones `config/vale/lint-prose.ts` already owns — this hook
 *   passes the path and reads the verdict rather than carrying its own copy of the pathspecs, the exclusions or the
 *   config choice. A path the surface excludes, or one git does not track, reports clean.
 *
 *   Every failure path is silence, the same interface as `symbol-precheck.ts`: a hook that throws on an unanticipated
 *   payload is a broken session rather than a missing hint.
 *
 *   Register it in `.claude/settings.json` under `hooks.PostToolUse` with matcher `Write|Edit`.
 */

import { readStandardInputJSON } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import { repoRootPath, repoRootPathBuilder } from "@mailwoman/core/paths"
import { isProcessError, runFile } from "@mailwoman/core/process"
import { relative, resolvePath } from "path-ts"

/**
 * Which Vale surface reads a file, by extension.
 *
 * `docs-vocab` is deliberately absent: it runs the same rules over a narrower set, so a file it
 * covers is already covered by `docs` here and a second pass would report each finding twice.
 */
const CODE_EXTENSIONS = [".ts", ".tsx", ".py", ".yaml", ".yml"]
const DOC_EXTENSIONS = [".md", ".mdx"]

function surfaceFor(filePath: string): "code" | "docs" | null {
	// A suffix test rather than `extname`: path-ts reads the extension out of the path's TYPE,
	// so a value widened to `string` answers `""` and every arm of a switch over it is unreachable.
	if (CODE_EXTENSIONS.some((extension) => filePath.endsWith(extension))) return "code"

	if (DOC_EXTENSIONS.some((extension) => filePath.endsWith(extension))) return "docs"

	return null
}

/**
 * The edited path the payload names, repo-relative, or null when it names none
 * or names one outside the repository.
 */
function editedPath(payload: Record<string, unknown> | null): string | null {
	const input = payload?.tool_input

	if (typeof input !== "object" || input === null) return null

	const filePath = (input as { file_path?: unknown }).file_path

	if (typeof filePath !== "string" || !filePath) return null

	const repoRelative = relative(repoRootPath(), resolvePath(filePath))

	// A scratch file outside the checkout is not a prose surface, and `..` is how that reads after resolution.
	return repoRelative.startsWith("..") ? null : repoRelative
}

async function main(): Promise<void> {
	const payload = await readStandardInputJSON<Record<string, unknown>>().catch(() => null)
	const filePath = editedPath(payload)

	if (!filePath) return

	const surface = surfaceFor(filePath)

	if (!surface) return

	const linter = repoRootPathBuilder("config", "vale", "lint-prose.ts")

	// Vale exits non-zero when it has error-severity findings, so the REPORT is on
	// stdout in both cases and the exit code carries no separate signal.
	const report = await runFile(process.execPath, [linter, surface, filePath], {
		cwd: repoRootPathBuilder(),
		maxBuffer: 8 * 1024 * 1024,
	}).catch((error: unknown) => (isProcessError(error) ? error : null))

	const output = (report?.stdout ?? "").trim()
	// The COUNT off Vale's summary, never the word: a clean run ends `✔ 0 errors, 0 warnings …`,
	// so a substring test for "error" blocks on every clean file.
	// Absent summary means absent output means nothing to report.
	const errorCount = Number(/^[✔✖]\s+(\d+)\s+error/mu.exec(output)?.[1] ?? 0)

	if (!errorCount) return

	process.stdout.write(
		stringifyJSON({
			decision: "block",
			reason:
				`Prose check on ${filePath}, the same rules \`yarn lint\` runs:\n\n${output}\n\n` +
				"Fix the flagged lines in this file now. Replace each flagged phrase with the concrete claim it hides " +
				"rather than deleting the word. A comment states the invariant, the constraint, or why an obvious " +
				"implementation is unsafe.",
		})
	)
}

await main().catch(() => void 0)
