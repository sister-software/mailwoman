/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The three copies of the third-party notices agree on which modules are MIT-derived, and each named module
 *   says so in its own header.
 *
 *   Mailwoman began as a fork of Pelias Parser under the MIT license, which conditions its grant on the copyright
 *   notice and the permission notice accompanying copies of the covered software; three files must describe the
 *   covered modules: the repository notices, the documentation site's page, and the copy inside `@mailwoman/core`
 *   that npm ships.
 *
 *   The check is mechanical: it reads the module paths each notice names, holds the three sets equal, requires each
 *   named file to exist, and requires each one's header to carry the derivation, without judging how derived a module
 *   is.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { resolvePath } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"

/**
 * The three notice files, each with the audience that reads it; the `packages/core` copy is the only one in
 * `@mailwoman/core`'s `files` array, so it is the one that reaches an installer.
 */
const NOTICE_FILES: ReadonlyArray<readonly [path: string, audience: string]> = [
	["THIRD_PARTY_NOTICES.md", "the repository's notices"],
	["docs/THIRD_PARTY_NOTICES.md", "the documentation site's acknowledgements page"],
	["packages/core/THIRD_PARTY_NOTICES.md", "the copy npm ships inside @mailwoman/core"],
]

/**
 * The package the MIT-derived modules live in, relative to which every notice writes their paths.
 */
const DERIVED_PACKAGE = "packages/core"

/**
 * The module paths a notice names, as `lib/tokenization/<name>.ts`; matching the path rather than a module name is
 * what makes a rename fail the check, since the notice is what a licensee reads.
 */
function derivedModulePaths(text: string): Set<string> {
	return new Set(text.match(/lib\/tokenization\/[A-Za-z]+\.ts/gu))
}

/**
 * The sentence a header carries to record the derivation, because a file's own header is where its reader looks
 * and a notice elsewhere in the tree does not reach them.
 */
const HEADER_MARKER = "Pelias Parser, MIT"

/**
 * The condition MIT attaches to its grant as the license states it, which the shipped copy must reproduce rather
 * than link to, since a consumer holds the tarball and not the upstream repository.
 */
const PERMISSION_NOTICE = "shall be included in all copies or substantial portions of the Software"

/**
 * The text with its blockquote markers stripped and every whitespace run folded to one space, because the
 * repository formatter rewraps the quoted license and matching the raw file would fail on a reflow that changed no
 * text a licensee reads.
 *
 * `@mailwoman/normalize`'s `collapseWhitespace` keeps newlines as segment separators and returns an offset map for
 * address text, so it is a different operation.
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
