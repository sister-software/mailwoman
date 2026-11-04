// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Reports a hand-typed collection of country codes in code that serves every country.
 *
 *   An array or `Set` literal of country codes held by a country-named binding, such as
 *   `const CJK_COUNTRIES = new Set(["JP", "CN", "TW", …])`, is a sample standing in for a rule. The branded sets in
 *   `@mailwoman/codex/country/sets` derive each collection from a named source, and this check makes a hand list
 *   declare itself. It reports three shapes:
 *
 *   - An array or `Set` literal of three or more two-letter codes assigned to a binding or property whose name
 *     reads as a country collection (`COUNTRIES`, `countryCodes`, `ISO2_LIST`).
 *   - The same literal passed straight to `countriesDeclaredBy`, which admits a list a file outside source declares.
 *   - A cast to `CountrySet`, the one escape from the brand, outside the module that defines it.
 *
 *   A finding is admitted in a per-country home (`isCountryHome`) or with a `country-branch: <reason>` comment on its
 *   statement or the comment block above it, stating why the list is a per-country fact and which source would replace
 *   it. Test sources are skipped. A list of subdivision codes held by a name such as `STATES` is not read as countries.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { relative, resolvePath } from "path-ts"
import ts from "typescript"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#repo-health/check"
import { COUNTRY_BRANCH_MARKER, isCountryHome } from "#repo-health/checks/country/branches"
import { trackedSourcePaths } from "#repo-health/tracked-sources"

/**
 * The module that defines `CountrySet` and so may cast to it.
 */
const SETS_MODULE = "packages/codex/lib/country/sets.ts"

const CODE_LITERAL = /^(?:[A-Z]{2}|[a-z]{2})$/u

/**
 * A binding or property name that reads as a collection of countries.
 */
const COUNTRY_COLLECTION_NAME = /country|countries|iso2|(?:^|_)ccs?$|^ccs?(?:_|$)/iu

const MIN_CODES = 3

/**
 * One hand-typed country collection or cast and its location.
 */
export interface CountryLiteralSet {
	file: string
	line: number
	kind: "literal" | "declared" | "cast"
	text: string
}

/**
 * Strips the `as const`, `satisfies` and parenthesis wrappers around a literal.
 */
function unwrap(node: ts.Expression): ts.Expression {
	let current = node

	while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current)) {
		current = current.expression
	}

	return current
}

/**
 * Returns the array literal an expression holds directly or as `new Set([...])`, or `null`.
 */
function collectionLiteral(node: ts.Expression): ts.ArrayLiteralExpression | null {
	const inner = unwrap(node)

	if (ts.isArrayLiteralExpression(inner)) return inner

	if (
		ts.isNewExpression(inner) &&
		ts.isIdentifier(inner.expression) &&
		/^(?:Readonly)?Set$/u.test(inner.expression.text) &&
		inner.arguments?.[0]
	) {
		const argument = unwrap(inner.arguments[0])

		return ts.isArrayLiteralExpression(argument) ? argument : null
	}

	return null
}

function codeCount(array: ts.ArrayLiteralExpression): number {
	return array.elements.filter((element) => ts.isStringLiteral(element) && CODE_LITERAL.test(element.text)).length
}

function bindingName(node: ts.Node): string | null {
	if (
		(ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) &&
		(ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
	) {
		return node.name.text
	}

	return null
}

function isCountrySetType(type: ts.TypeNode): boolean {
	return ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === "CountrySet"
}

/**
 * Returns every hand-typed country collection and `CountrySet` cast in the given sources
 * that sits outside a per-country home and carries no `country-branch:` marker.
 */
export function findCountryLiteralSets(files: ReadonlyArray<{ file: string; text: string }>): CountryLiteralSet[] {
	const found: CountryLiteralSet[] = []

	for (const { file, text } of files) {
		if (isCountryHome(file)) continue

		// A substring search skips a file with neither a quoted two-letter code nor the brand's name before parsing.
		if (!/"[A-Za-z]{2}"/u.test(text) && !text.includes("CountrySet")) continue

		const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
		const lineStarts = source.getLineStarts()
		const lineOf = (position: number) => source.getLineAndCharacterOfPosition(position).line + 1

		const lineText = (line: number): string =>
			line < 1 || line > lineStarts.length ? "" : text.slice(lineStarts[line - 1], lineStarts[line] ?? text.length)

		const marked = (node: ts.Node): boolean => {
			let holder: ts.Node = node

			while (holder.parent && !ts.isStatement(holder) && !ts.isClassElement(holder)) {
				holder = holder.parent
			}

			const start = lineOf(holder.getStart(source))
			const end = lineOf(holder.getEnd())

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

		const report = (node: ts.Node, kind: CountryLiteralSet["kind"], label: string): void => {
			if (marked(node)) return

			found.push({ file, line: lineOf(node.getStart(source)), kind, text: label })
		}

		const visit = (node: ts.Node): void => {
			const name = bindingName(node)
			const initializer = (node as { initializer?: ts.Expression }).initializer

			if (name && initializer && COUNTRY_COLLECTION_NAME.test(name)) {
				const array = collectionLiteral(initializer)

				if (array && codeCount(array) >= MIN_CODES) {
					report(node, "literal", name)
				}
			}

			if (
				ts.isCallExpression(node) &&
				ts.isIdentifier(node.expression) &&
				node.expression.text === "countriesDeclaredBy" &&
				node.arguments[1]
			) {
				const array = collectionLiteral(node.arguments[1])

				if (array && codeCount(array) >= MIN_CODES) {
					report(node, "declared", node.getText(source).replaceAll(/\s+/gu, " "))
				}
			}

			if (
				file !== SETS_MODULE &&
				(ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
				isCountrySetType(node.type)
			) {
				report(node, "cast", node.getText(source).replaceAll(/\s+/gu, " "))
			}

			node.forEachChild(visit)
		}

		source.forEachChild(visit)
	}

	return found
}

const MESSAGES: Readonly<Record<CountryLiteralSet["kind"], (text: string) => string>> = {
	literal: (name) =>
		`\`${name}\` hand-types a list of country codes. Derive it from a named source with ` +
		"`@mailwoman/codex/country/sets` (worldCountries, countriesOfScript, countriesOfAddressSystem, " +
		`countriesOfWeightsFamily, dependencies), or write \`// ${COUNTRY_BRANCH_MARKER} <reason>\` above it stating ` +
		"why the list is a per-country fact and which source would replace it.",
	declared: (call) =>
		`\`${call}\` passes a literal list to countriesDeclaredBy, which admits a list declared outside source. ` +
		`Derive the set from a named source, or write \`// ${COUNTRY_BRANCH_MARKER} <reason>\` above it.`,
	cast: (cast) =>
		`\`${cast}\` casts to CountrySet, which skips the source the brand records. Build the set with a constructor ` +
		"from `@mailwoman/codex/country/sets`.",
}

/**
 * The `country-literal-sets` check.
 *
 * It reports one error for each hand-typed country collection or `CountrySet` cast in a shared module.
 */
export const countryLiteralSetsCheck: RepoCheck = {
	id: "country-literal-sets",
	description:
		"A country collection outside a country home derives from a named source in `@mailwoman/codex/country/sets`, or states its reason with `country-branch:`.",
	async run(context) {
		const sources = (await trackedSourcePaths(context, { existingOnly: true }))
			.map((path) => relative(context.repoRoot, path))
			.filter((file) => /\.tsx?$/u.test(file) && !/\/test\/|\.test\.tsx?$/u.test(file))

		const files: { file: string; text: string }[] = []

		for (const file of sources) {
			files.push({ file, text: await readLocalTextFile(resolvePath(context.repoRoot, file)) })
		}

		return findCountryLiteralSets(files).map((finding): Diagnostic => ({
			severity: DiagnosticSeverity.Error,
			message: MESSAGES[finding.kind](finding.text),
			file: finding.file,
			line: finding.line,
			details: null,
		}))
	},
}
