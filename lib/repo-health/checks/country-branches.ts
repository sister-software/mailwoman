/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reports a branch on one hard-coded country in code that serves every country.
 *
 *   A comparison such as `country === "US"` in a shared module gives one country a path the rest of the
 *   planet does not get, and the code carries no mark of it. The venue-head exclusion read subdivision codes for
 *   US, CA and AU from codex tables while a planetary source sat in the admin database. The check makes
 *   every such branch declare itself.
 *
 *   A branch is admitted in three places. A module under a country directory or with a country file name,
 *   whose path has a segment that is an ISO 3166-1 alpha-2 code in lowercase such as
 *   `packages/corpus/lib/us/` or `postcode/locality/jp.ts`, is per-country code by its home. A module under `packages/codex/` holds per-country data by definition. Anywhere else, the
 *   statement's line or the line above it carries `country-branch: <reason>`, which states why the rule is
 *   one country's and what planetary source would replace it.
 *
 *   `ZZ` is the synthetic-row country rather than a place, so a comparison against it is admitted.
 *   Test sources are skipped. The check cannot see a country held in a variable or a set.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { relative, resolvePath } from "path-ts"
import ts from "typescript"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#repo-health/check"
import { trackedSourcePaths } from "#repo-health/tracked-sources"

/**
 * The marker a shared module writes beside a country branch it keeps on purpose.
 */
const COUNTRY_BRANCH_MARKER = "country-branch:"

const COUNTRY_LITERAL = /^[A-Z]{2}$/u

/**
 * The code the corpus writes on a synthetic row that belongs to no country.
 */
const SYNTHETIC_COUNTRY = "ZZ"

/**
 * The operand spellings the check reads as a country value.
 */
const COUNTRY_OPERAND = /(?:^|[.?!])(?:country|cc|iso2|countryCode|resolvedCountry|countryISO2)$/iu

const COMPARISONS = new Set<ts.SyntaxKind>([
	ts.SyntaxKind.EqualsEqualsEqualsToken,
	ts.SyntaxKind.ExclamationEqualsEqualsToken,
	ts.SyntaxKind.EqualsEqualsToken,
	ts.SyntaxKind.ExclamationEqualsToken,
])

/**
 * Returns whether a repository-relative path is a per-country home: a segment that
 * is a two-letter lowercase code, or the codex package.
 */
export function isCountryHome(file: string): boolean {
	if (file.startsWith("packages/codex/")) return true

	const segments = file.split("/")
	const basename = segments.at(-1)!.replace(/\.tsx?$/u, "")

	return /^[a-z]{2}$/u.test(basename) || segments.slice(0, -1).some((segment) => /^[a-z]{2}$/u.test(segment))
}

function isCountryLiteral(node: ts.Node): node is ts.StringLiteral {
	return ts.isStringLiteral(node) && COUNTRY_LITERAL.test(node.text) && node.text !== SYNTHETIC_COUNTRY
}

function isCountryOperand(node: ts.Node, source: ts.SourceFile): boolean {
	return COUNTRY_OPERAND.test(node.getText(source).replaceAll(/\s+/gu, ""))
}

/**
 * One country branch and its location.
 */
export interface CountryBranch {
	file: string
	line: number
	text: string
}

/**
 * Returns every country branch in the given sources that sits outside a per-country home
 * and carries no `country-branch:` marker on its line or the line above.
 */
export function findCountryBranches(files: ReadonlyArray<{ file: string; text: string }>): CountryBranch[] {
	const found: CountryBranch[] = []

	for (const { file, text } of files) {
		if (isCountryHome(file)) continue

		// Most files compare no country, so a text search skips them before parsing.
		if (!/"[A-Z]{2}"/u.test(text)) continue

		const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
		const lineStarts = source.getLineStarts()
		const lineOf = (position: number) => source.getLineAndCharacterOfPosition(position).line + 1

		// The text of a one-based line, read from the parsed source's line table rather than a split copy.
		const lineText = (line: number): string =>
			line < 1 || line > lineStarts.length ? "" : text.slice(lineStarts[line - 1], lineStarts[line] ?? text.length)

		// The marker counts on the statement's own line or anywhere in the comment block right
		// above the statement (or case clause) that holds the branch, so a wrapped statement
		// or a two-line reason is read the same as a one-line one.
		const marked = (node: ts.Node): boolean => {
			let holder: ts.Node = node

			while (holder.parent && !ts.isStatement(holder) && !ts.isCaseClause(holder)) {
				holder = holder.parent
			}

			const start = lineOf(holder.getStart(source))
			const end = lineOf(node.getEnd())

			for (let line = start; line <= end; line++) {
				if (lineText(line).includes(COUNTRY_BRANCH_MARKER)) return true
			}

			for (let line = start - 1; line >= 1; line--) {
				const trimmed = lineText(line).trim()

				if (trimmed.includes(COUNTRY_BRANCH_MARKER)) return true

				if (!/^(?:\/\/|\/\*|\*)/u.test(trimmed)) return false
			}

			return false
		}

		const report = (node: ts.Node): void => {
			if (marked(node)) return

			found.push({ file, line: lineOf(node.getStart(source)), text: node.getText(source).replaceAll(/\s+/gu, " ") })
		}

		const visit = (node: ts.Node): void => {
			if (ts.isBinaryExpression(node) && COMPARISONS.has(node.operatorToken.kind)) {
				const [a, b] = [node.left, node.right]

				if (
					(isCountryLiteral(b) && isCountryOperand(a, source)) ||
					(isCountryLiteral(a) && isCountryOperand(b, source))
				) {
					report(node)
				}
			} else if (ts.isSwitchStatement(node) && isCountryOperand(node.expression, source)) {
				for (const clause of node.caseBlock.clauses) {
					if (ts.isCaseClause(clause) && isCountryLiteral(clause.expression)) {
						report(clause)
					}
				}
			}

			node.forEachChild(visit)
		}

		source.forEachChild(visit)
	}

	return found
}

/**
 * The `country-branches` check.
 *
 * It reports one error for each undeclared branch on one country in a shared module.
 */
export const countryBranchesCheck: RepoCheck = {
	id: "country-branches",
	description:
		"A branch on one hard-coded country lives under a country directory or the codex, or states its reason with `country-branch:`.",
	async run(context) {
		const sources = (await trackedSourcePaths(context, { existingOnly: true }))
			.map((path) => relative(context.repoRoot, path))
			.filter((file) => /\.tsx?$/u.test(file) && !/\/test\/|\.test\.tsx?$/u.test(file))

		const files: { file: string; text: string }[] = []

		for (const file of sources) {
			files.push({ file, text: await readLocalTextFile(resolvePath(context.repoRoot, file)) })
		}

		return findCountryBranches(files).map((branch): Diagnostic => ({
			severity: DiagnosticSeverity.Error,
			message:
				`\`${branch.text}\` gives one country a path the rest of the planet does not get. Move the rule into ` +
				`per-country data (a codex table or a module under a country directory), or write \`// ${COUNTRY_BRANCH_MARKER} <reason>\` ` +
				`on the line above stating why the rule is one country's and which planetary source would replace it.`,
			file: branch.file,
			line: branch.line,
			details: null,
		}))
	},
}
