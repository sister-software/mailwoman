/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The three copies of the third-party notices agree on which modules are MIT-derived, and each named module
 *   says so in its own header.
 *
 *   Mailwoman began as a fork of Pelias Parser under the MIT license, and MIT conditions its grant on the copyright
 *   notice and the permission notice accompanying copies of the covered software. Discharging that depends on the
 *   notice being accurate about which modules it covers, and three files describe them: the repository notices, the
 *   documentation site's page, and the copy inside `@mailwoman/core` that npm ships to a consumer.
 *
 *   Nothing compared the three, and they drifted in both directions. Two named rule-based classifiers and a solver
 *   that were deleted in v7.0.0, which claims an obligation over code no package contains. None named the surviving
 *   modules by path, so a rename would have left a notice pointing nowhere with no error anywhere.
 *
 *   The check is mechanical. It reads the module paths each notice names, holds the three sets equal, requires each
 *   named file to exist, and requires each one's header to carry the derivation. It does not judge how derived a
 *   module is, which is not a question a repository check can answer.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { resolvePath } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"

/**
 * The three notice files, each with the audience that reads it.
 *
 * `packages/core/THIRD_PARTY_NOTICES.md` is the one in the `files` array of `@mailwoman/core`, so it
 * is the only copy that reaches somebody who installs the package rather than opening the repository.
 */
const NOTICE_FILES: ReadonlyArray<readonly [path: string, audience: string]> = [
	["THIRD_PARTY_NOTICES.md", "the repository's notices"],
	["docs/THIRD_PARTY_NOTICES.md", "the documentation site's acknowledgements page"],
	["packages/core/THIRD_PARTY_NOTICES.md", "the copy npm ships inside @mailwoman/core"],
]

/**
 * The package the MIT-derived modules live in.
 *
 * Their paths are written relative to it in every notice.
 */
const DERIVED_PACKAGE = "packages/core"

/**
 * The module paths a notice names, as `lib/tokenization/<name>.ts`.
 *
 * Matching the path rather than a module name is what makes a rename fail the check: a moved
 * file stops existing at the path the notice prints, and the notice is what a licensee reads.
 */
function derivedModulePaths(text: string): Set<string> {
	return new Set(text.match(/lib\/tokenization\/[A-Za-z]+\.ts/gu))
}

/**
 * The sentence a header carries to record the derivation.
 *
 * A file's own header is where a reader of that file looks, and a notice
 * elsewhere in the tree does not reach them.
 */
const HEADER_MARKER = "Pelias Parser, MIT"

/**
 * The condition MIT attaches to its grant, as the license states it.
 *
 * The copy that ships has to reproduce it rather than link to it, since a consumer
 * holds the tarball and not the upstream repository.
 */
const PERMISSION_NOTICE = "shall be included in all copies or substantial portions of the Software"

/**
 * The text with its blockquote markers stripped and every whitespace run folded to one space.
 *
 * The license text is quoted prose that the repository formatter rewraps to its
 * own width, so matching the license's sentence against the raw file would fail
 * on a reflow that changed nothing a licensee reads.
 *
 * `@mailwoman/normalize`'s `collapseWhitespace` is a different operation: it keeps
 * newlines as segment separators and returns an offset map for address text.
 * This folds newlines away and returns a string.
 */
function foldQuotedProse(text: string): string {
	return text.replaceAll(/^[\t >]+/gmu, "").replaceAll(/\s+/gu, " ")
}

/**
 * The file that has to carry {@link PERMISSION_NOTICE} in full.
 */
const SHIPPED_NOTICE = "packages/core/THIRD_PARTY_NOTICES.md"

/**
 * The `third-party-notices` check: the notices agree, name files that exist, and each file says so itself.
 */
export const thirdPartyNoticesCheck: RepoCheck = {
	id: "third-party-notices",
	description: "The third-party notice copies name the same MIT-derived modules, and each module's header agrees.",
	async run(context) {
		const diagnostics: Diagnostic[] = []
		const named = new Map<string, Set<string>>()

		for (const [path, audience] of NOTICE_FILES) {
			let text: string

			try {
				text = await readLocalTextFile(resolvePath(context.repoRoot, path))
			} catch {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `${path} is ${audience} and could not be read, so what it claims about third-party terms is unknown`,
					file: path,
				})

				continue
			}

			named.set(path, derivedModulePaths(text))

			if (path === SHIPPED_NOTICE && !foldQuotedProse(text).includes(PERMISSION_NOTICE)) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `${path} is ${audience} and does not reproduce the MIT permission notice, which the license requires accompany a copy — a link to it is not an inclusion of it`,
					file: path,
				})
			}
		}

		const [reference, ...others] = [...named.entries()]

		if (!reference) return diagnostics

		const [referencePath, referenceModules] = reference

		if (!referenceModules.size) {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				message: `${referencePath} names no MIT-derived module by path. A notice that describes them in prose alone cannot be checked against the tree, and a rename would leave it silently wrong`,
				file: referencePath,
			})

			return diagnostics
		}

		for (const [path, modules] of others) {
			const missing = [...referenceModules].filter((module) => !modules.has(module))
			const extra = [...modules].filter((module) => !referenceModules.has(module))

			if (missing.length) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `${path} omits ${missing.join(", ")}, which ${referencePath} records as MIT-derived — the two copies describe different obligations`,
					file: path,
				})
			}

			if (extra.length) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `${path} names ${extra.join(", ")} as MIT-derived and ${referencePath} does not — one of them claims an obligation the other does not`,
					file: path,
				})
			}
		}

		for (const module of referenceModules) {
			const modulePath = `${DERIVED_PACKAGE}/${module}`
			let source: string

			try {
				source = await readLocalTextFile(resolvePath(context.repoRoot, modulePath))
			} catch {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `${referencePath} records ${module} as MIT-derived and no file exists at ${modulePath} — a moved or deleted module leaves the notice pointing at nothing`,
					file: referencePath,
				})

				continue
			}

			if (source.includes(HEADER_MARKER)) continue

			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				message: `${modulePath} is recorded as MIT-derived in ${referencePath} and its header does not say so — a reader of the file sees an AGPL header alone`,
				file: modulePath,
			})
		}

		return diagnostics
	},
}
