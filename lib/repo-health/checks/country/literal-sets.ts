// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Reports a hand-typed collection of country codes in code that serves every country.
 *
 *   An array or `Set` literal of country codes held by a binding whose name contains a country word, such as
 *   `const CJK_COUNTRIES = new Set(["JP", "CN", "TW", …])`, is a sample standing in for a rule. The branded sets in
 *   `@mailwoman/codex/country/sets` derive each collection from one source table, and this check makes a hand list
 *   declare itself. It reports three shapes:
 *
 *   - An array or `Set` literal of three or more two-letter codes assigned to a binding or property whose name
 *     reads as a country collection (`COUNTRIES`, `countryCodes`, `ISO2_LIST`).
 *   - The same literal passed straight to `countriesDeclaredBy`, which admits a list a file outside source declares.
 *   - A cast to `CountrySet`, the one escape from the brand, outside the module that defines it.
 *
 *   A finding is admitted in a per-country home (`isCountryHome`) or with a `country-branch: <reason>` comment on its
 *   statement or the comment block above it, stating why the list is a per-country fact and which source would replace
 *   it. Test sources are skipped. A list of subdivision codes held by a name such as `STATES` isn't read as countries.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { relative, resolvePath } from "path-ts"
import ts from "typescript"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#repo-health/check"
import {
	collectionLiteral,
	COUNTRY_BRANCH_MARKER,
	COUNTRY_COLLECTION_NAME,
	isMarkedCountryBranch,
	isCountryHome,
	MIN_COLLECTION_CODES,
} from "#repo-health/checks/country/branches"
import { trackedSourcePaths } from "#repo-health/tracked-sources"

/**
 * The module that defines `CountrySet` and so may cast to it.
 */
const SETS_MODULE = "packages/codex/lib/country/sets.ts"

const CODE_LITERAL = /^(?:[A-Z]{2}|[a-z]{2})$/u

/**
 * One hand-typed country collection or cast and its location.
 */
export interface CountryLiteralSet {
	file: string
	line: number
	kind: "literal" | "declared" | "cast"
	text: string
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
 * Returns every hand-typed country collection and `CountrySet` cast in the given sources that
 * sits outside a per-country home and has no `country-branch:` comment on the line above.
 */
export function findCountryLiteralSets(files: ReadonlyArray<{ file: string; text: string }>): CountryLiteralSet[] {
	const found: CountryLiteralSet[] = []

	for (const { file, text } of files) {
		if (isCountryHome(file)) continue

		// A substring search skips a file with neither a quoted two-letter code nor the brand's name before parsing.
		if (!/"[A-Za-z]{2}"/u.test(text) && !text.includes("CountrySet")) continue

		// A `.ts` module parsed as TSX reads a generic arrow function as an element and loses the rest of the file.
		const scriptKind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
		const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, scriptKind)

		const report = (node: ts.Node, kind: CountryLiteralSet["kind"], label: string): void => {
			if (isMarkedCountryBranch(source, node)) return

			found.push({
				file,
				line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
				kind,
				text: label,
			})
		}

		const visit = (node: ts.Node): void => {
			const name = bindingName(node)
			const initializer = (node as { initializer?: ts.Expression }).initializer

			if (name && initializer && COUNTRY_COLLECTION_NAME.test(name)) {
				const array = collectionLiteral(initializer)

				if (array && codeCount(array) >= MIN_COLLECTION_CODES) {
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

				if (array && codeCount(array) >= MIN_COLLECTION_CODES) {
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
			// A `.generated.ts` file is written from tables in a country home, and the check reads those tables there.
			// A reason comment in generated output would be removed by the next generation.
			.filter((file) => /\.tsx?$/u.test(file) && !/\/test\/|\.test\.tsx?$|\.generated\.tsx?$/u.test(file))

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
