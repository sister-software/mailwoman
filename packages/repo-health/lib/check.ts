/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The shape every repository health check takes: it inspects the checkout and returns diagnostics. The admission
 *   rule is in the type. A check has no way to mutate, generate, publish, benchmark or probe, because `run` returns
 *   diagnostics and nothing else is asked of it.
 */

/**
 * How a diagnostic counts: an `error` fails its check, a `warning` is reported and never fails it.
 */
export const DiagnosticSeverity = {
	/**
	 * Fails the check.
	 */
	Error: "error",
	/**
	 * Reported, never fails the check.
	 */
	Warning: "warning",
} as const

export type DiagnosticSeverity = (typeof DiagnosticSeverity)[keyof typeof DiagnosticSeverity]

export interface Diagnostic {
	severity: DiagnosticSeverity
	/**
	 * One sentence a reader can act on.
	 * The file and line, when there is one, come separately.
	 */
	message: string
	file?: string
	line?: number
	/**
	 * The sites behind the message, one per line, for a check that counts rather than points.
	 *
	 * A count on its own tells a reader that something grew and leaves them to find it.
	 * These print under the message, indented, and ride along in `--json` as they are.
	 */
	details?: readonly string[]
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
	 * Stable, and the name an adapter exposes: `exports`, `version-sync`, `test-interface`.
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
