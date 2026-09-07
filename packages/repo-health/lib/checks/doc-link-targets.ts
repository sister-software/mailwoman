/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A `{@link}` or `{@linkcode}` naming a symbol nothing declares. The tag reads as a promise that the thing
 *   exists, and an agent following one implements the name instead of finding the code: `readPackageJSONFile` was
 *   never a declaration anywhere in this repository, only a `@see {@linkcode …}` target, and it was written twice
 *   before anyone noticed there was nothing to find.
 *
 *   WHAT IT CHECKS. Only a bare identifier target — `{@link foo}`, `{@linkcode Foo.bar}` — against the set of names
 *   the tree declares or imports anywhere. A URL target, a path, and a `{@link foo | text}` label are all left alone.
 *   The name set is repository-wide rather than per-file on purpose: a link to a name declared in another package is
 *   correct and common, so a per-file rule would report thousands of them.
 *
 *   THAT WIDTH IS THE LIMIT, and it is stated rather than hidden: a tag naming a symbol that exists SOMEWHERE but not
 *   where the reader can reach it still passes. What this refuses is the name that exists nowhere at all, which is the
 *   case that sends someone off to write it.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { relative } from "path-ts"
import ts from "typescript"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck, type RepoContext } from "#check"
import { trackedSourcePaths } from "#tracked-sources"

/**
 * A link tag and its target, up to the first separator: `{@link foo}`, `{@linkcode Foo.bar | text}`.
 */
const LINK_TAG = /\{@link(?:code|plain)?\s+(?<target>[^}\s|]+)/gu

/**
 * A target this cannot judge: a URL, a path, a file, or anything that is not a plain dotted identifier.
 */
function isJudgeable(target: string): boolean {
	if (/^(?:https?:|\.|\/|#)/u.test(target)) return false

	return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u.test(target)
}

/**
 * Every name the file declares, imports or exports — the vocabulary a link in this repository may name.
 */
function declaredNames(text: string, file: string, into: Set<string>): void {
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)

	const visit = (node: ts.Node): void => {
		if (
			(ts.isFunctionDeclaration(node) ||
				ts.isClassDeclaration(node) ||
				ts.isInterfaceDeclaration(node) ||
				ts.isTypeAliasDeclaration(node) ||
				ts.isEnumDeclaration(node) ||
				ts.isModuleDeclaration(node)) &&
			node.name &&
			ts.isIdentifier(node.name)
		) {
			into.add(node.name.text)
		}

		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
			into.add(node.name.text)
		}
		if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) {
			into.add(node.name.text)
		}
		if (ts.isImportClause(node) && node.name) {
			into.add(node.name.text)
		}
		if (ts.isPropertySignature(node) && node.name && ts.isIdentifier(node.name)) {
			into.add(node.name.text)
		}
		if (ts.isMethodSignature(node) && node.name && ts.isIdentifier(node.name)) {
			into.add(node.name.text)
		}
		if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
			into.add(node.name.text)
		}
		if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
			into.add(node.name.text)
		}
		if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
			into.add(node.name.text)
		}

		ts.forEachChild(node, visit)
	}

	visit(source)
}

export interface DanglingLink {
	file: string
	line: number
	target: string
}

/**
 * This module's own repo-relative path, excluded from the sweep it performs: the header has to SPELL the tag shapes it
 * looks for, and `{@link foo}` in an explanation is an example rather than a promise. `debt.ts` excludes itself from
 * its own vocabulary count for the same reason.
 */
const SELF = "packages/repo-health/lib/checks/doc-link-targets.ts"

/**
 * Every link tag naming something the tree never declares.
 */
export async function findDanglingLinks(context: RepoContext): Promise<DanglingLink[]> {
	const paths = await trackedSourcePaths(context, {
		globs: ["packages/*/lib/*.ts", "packages/*/lib/**/*.ts"],
		existingOnly: true,
	})

	const texts = new Map<string, string>()
	const known = new Set<string>()

	for (const path of paths) {
		const file = relative(context.repoRoot, path)

		if (file.endsWith(".d.ts")) continue

		const text = await readLocalTextFile(path)

		texts.set(file, text)
		declaredNames(text, file, known)
	}

	const dangling: DanglingLink[] = []

	for (const [file, text] of texts) {
		if (file === SELF) continue

		for (const match of text.matchAll(LINK_TAG)) {
			const target = match.groups?.["target"] ?? ""

			if (!isJudgeable(target)) continue

			// A dotted target is satisfied by its head: `Foo.bar` is reachable when `Foo` is.
			const head = target.split(".")[0]!

			if (known.has(head)) continue

			// A language built-in is a legitimate target and belongs to no file. Asked of the runtime rather than kept as
			// a list, which would go stale against the platform.
			if (head in globalThis) continue

			// oxlint-disable-next-line mailwoman/prefer-spliterator -- counting newlines in a string already resident.
			const line = text.slice(0, match.index).split("\n").length

			dangling.push({ file, line, target })
		}
	}

	return dangling.toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

/**
 * The check: each dangling link as a warning, because a tag promising a symbol that does not exist is how a name gets
 * implemented instead of imported.
 */
export const docLinkTargetsCheck: RepoCheck = {
	id: "doc-link-targets",
	description:
		"A {@link} or {@linkcode} in packages/*/lib naming a symbol nothing in the tree declares — the tag reads as a promise the thing exists.",
	async run(context) {
		const diagnostics: Diagnostic[] = []

		for (const link of await findDanglingLinks(context)) {
			diagnostics.push({
				severity: DiagnosticSeverity.Warning,
				file: link.file,
				line: link.line,
				message: `\`{@link ${link.target}}\` names nothing this repository declares. Point it at the symbol that exists, or write the name in plain text.`,
			})
		}

		return diagnostics
	},
}
