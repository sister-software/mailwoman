/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file What a module move is, and what planning one produces.
 *
 * Every path here is repo-relative in `git ls-files` form, so a plan reads the same in a terminal, in a
 * JSON payload, and in a test fixture that has no checkout behind it.
 */

export interface ModuleMove {
	from: string
	to: string
}

export interface SpecifierRewrite {
	/**
	 * The move's `to` path when the specifier sits in a module that itself moves.
	 */
	file: string
	specifier: string
	replacement: string
	/**
	 * The file both spellings name, which the replacement was proven against
	 * and a verification pass re-resolves once the move is on disk.
	 */
	target: string
	/**
	 * Offsets of the quoted literal in the file's text, quotes included,
	 * so the applier splices without re-parsing.
	 */
	start: number
	end: number
}

export interface ManifestRewrite {
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
	 * The file holding the path, at its post-move location.
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
	 * What was tried and why no specifier was accepted.
	 *
	 * A plan carrying one of these is refused rather than applied.
	 */
	reason: string
}

export interface ModuleMovePlan {
	moves: ModuleMove[]
	rewrites: SpecifierRewrite[]
	/**
	 * `exports`/`imports` targets the moves invalidate.
	 * A subpath KEY never changes.
	 */
	manifestRewrites: ManifestRewrite[]
	/**
	 * Repo-relative paths written as text — a hook command, a lint glob, a `Usage:`
	 * line — that the moves invalidate and no check reads.
	 */
	pathLiterals: PathLiteralRewrite[]
	unresolved: UnresolvedSpecifier[]
	/**
	 * Files read to find the rewrites, against the tracked-source total they were drawn from.
	 */
	scanned: { read: number; tracked: number }
}
