/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * A check has no way to mutate, generate, publish, benchmark or probe, because `run` returns diagnostics and no other result is asked of it.
 */

/**
 * How a diagnostic counts: an `error` fails its check, a `warning` is reported and never fails it.
 */
export const DiagnosticSeverity = {
	Error: "error",
	Warning: "warning",
} as const

export type DiagnosticSeverity = (typeof DiagnosticSeverity)[keyof typeof DiagnosticSeverity]

export interface Diagnostic {
	severity: DiagnosticSeverity
	/**
	 * One sentence a reader can act on, with the file and line, when known, reported separately.
	 */
	message: string
	file: string | null
	line: number | null
	/**
	 * The sites behind a count print indented under the message and ride along in `--json`,
	 * because a count on its own leaves a reader to find the growth.
	 */
	details: readonly string[] | null
}

export interface RepoContext {
	repoRoot: string
	/**
	 * Tracked files, as `git ls-files` lists them, so no check re-walks the tree
	 * or reads an untracked scratch file.
	 */
	trackedFiles: readonly string[]
}

export interface RepoCheck {
	/**
	 * Stable and the name an adapter exposes: `exports`, `version-sync`, `test-layout`.
	 */
	id: string
	description: string
	run(context: RepoContext): Promise<Diagnostic[]>
}

/**
 * A check passes when it reports no error-severity diagnostic.
 */
export function checkPassed(diagnostics: readonly Diagnostic[]): boolean {
	return diagnostics.every((diagnostic) => diagnostic.severity !== DiagnosticSeverity.Error)
}
