/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The three copies of the third-party notices list the same MIT-derived modules.
 *   Each listed module records its origin in its own header.
 *
 *   Mailwoman began as a fork of Pelias Parser under the MIT license. The license requires copies of the covered
 *   software to include its copyright and permission notices. Three files describe the covered modules.
 *   The repository holds one notice. The documentation site holds a second page. npm ships the third inside `@mailwoman/core`.
 *
 *   The check reads the module paths in each notice and compares the three sets.
 *   It verifies that every listed file exists and that each file header records the derivation.
 *   It does not assess how much of a module comes from the original project.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { resolvePath } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#repo-health/check"

/**
 * The three notice files, each with the audience that reads it.
 *
 * The `packages/core` copy is the only one in `@mailwoman/core`'s `files` array,
 * so it is the one that reaches an installer.
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
 * The module paths in a notice use the form `lib/tokenization/<name>.ts`.
 *
 * A path match makes a rename fail the check because licensees read the notice.
 */
function derivedModulePaths(text: string): Set<string> {
	return new Set(text.match(/lib\/tokenization\/[A-Za-z]+\.ts/gu))
}

/**
 * The sentence a header includes to record the derivation.
 *
 * Readers find it in the file header.
 * A separate notice elsewhere in the tree may not reach them.
 */
const HEADER_MARKER = "Pelias Parser, MIT"

/**
 * MIT requires each copy of the software to include this notice.
 *
 * The shipped copy reproduces the text because consumers receive the tarball.
 */
const PERMISSION_NOTICE = "shall be included in all copies or substantial portions of the Software"

/**
 * The function strips blockquote markers and folds whitespace runs to one space.
 *
 * The repository formatter rewraps this quoted license.
 * A raw-text comparison would fail after a reflow that leaves the license content unchanged.
 *
 * `@mailwoman/normalize`'s `collapseWhitespace` keeps newlines as segment separators
 * and returns an offset map for address text, so it is a different operation.
 */
function foldQuotedProse(text: string): string {
	return text.replaceAll(/^[\t >]+/gmu, "").replaceAll(/\s+/gu, " ")
}

/**
 * The file that has to include {@link PERMISSION_NOTICE} in full.
 */
const SHIPPED_NOTICE = "packages/core/THIRD_PARTY_NOTICES.md"

/**
 * The `third-party-notices` check compares notice files and verifies each listed file's header.
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
					line: null,
					details: null,
				})

				continue
			}

			named.set(path, derivedModulePaths(text))

			if (path === SHIPPED_NOTICE && !foldQuotedProse(text).includes(PERMISSION_NOTICE)) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `${path} is ${audience} and does not reproduce the MIT permission notice, which the license requires accompany a copy — a link to it is not an inclusion of it`,
					file: path,
					line: null,
					details: null,
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
				line: null,
				details: null,
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
					line: null,
					details: null,
				})
			}

			if (extra.length) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `${path} names ${extra.join(", ")} as MIT-derived and ${referencePath} does not — one of them claims an obligation the other does not`,
					file: path,
					line: null,
					details: null,
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
					line: null,
					details: null,
				})

				continue
			}

			if (source.includes(HEADER_MARKER)) continue

			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				message: `${modulePath} is recorded as MIT-derived in ${referencePath} and its header does not say so — a reader of the file sees an AGPL header alone`,
				file: modulePath,
				line: null,
				details: null,
			})
		}

		return diagnostics
	},
}
