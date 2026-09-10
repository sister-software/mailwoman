/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file What a module move is, and what planning one produces.
 *
 *   Every path here is repo-relative in `git ls-files` form, so a plan reads the same in a terminal, in a JSON
 *   payload, and in a test fixture that has no checkout behind it.
 */

export interface ModuleMove {
	/**
	 * The module's current path.
	 */
	from: string
	/**
	 * Where it goes.
	 */
	to: string
}

export interface SpecifierRewrite {
	/**
	 * The file holding the specifier — the move's `to` path when the specifier sits in a module that itself moves.
	 */
	file: string
	specifier: string
	replacement: string
	/**
	 * The file both spellings name — the one the replacement was proven against, and the one a verification pass
	 * re-resolves it to once the move is on disk.
	 */
	target: string
	/**
	 * Offsets of the quoted literal in the file's text, quotes included, so the applier splices without re-parsing.
	 */
	start: number
	end: number
}

export interface ManifestRewrite {
	/**
	 * The manifest holding the target, repo-relative.
	 */
	file: string
	target: string
	replacement: string
	/**
	 * Offsets of the quoted target in the manifest text, quotes included.
	 */
	start: number
	end: number
}

export interface PathLiteralRewrite {
	/**
	 * The file holding the path, repo-relative and at its post-move location.
	 */
	file: string
	path: string
	replacement: string
	/**
	 * Offsets of the path itself, with no quotes: it can sit inside a glob, a shell command, or a sentence.
	 */
	start: number
	end: number
}

export interface UnresolvedSpecifier {
	file: string
	specifier: string
	/**
	 * What was tried and why nothing was accepted. A plan carrying one of these is refused rather than applied: a
	 * specifier nobody can prove is a specifier nobody should write.
	 */
	reason: string
}

export interface ModuleMovePlan {
	moves: ModuleMove[]
	rewrites: SpecifierRewrite[]
	/**
	 * `exports`/`imports` targets the moves invalidate. A subpath KEY never changes: it is the package's contract, and a
	 * file moving underneath it is not a consumer's business.
	 */
	manifestRewrites: ManifestRewrite[]
	/**
	 * Repo-relative paths written as text — a hook command, a lint glob, a `Usage:` line — that the moves invalidate.
	 * Nothing checks these, which is why the operation that breaks them is the one that reports them.
	 */
	pathLiterals: PathLiteralRewrite[]
	unresolved: UnresolvedSpecifier[]
	/**
	 * Files read to find the rewrites, against the tracked-source total they were drawn from. The pre-filter in `plan.ts`
	 * is what separates the two numbers; a reader comparing them can see whether it did any work.
	 */
	scanned: { read: number; tracked: number }
}
