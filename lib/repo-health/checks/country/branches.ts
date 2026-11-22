// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Reports a branch on one hard-coded country in code that serves every country.
 *
 *   A comparison such as `country === "US"` in a shared module gives one country a path the rest of the
 *   planet doesn't get, and the code has no mark of it. The venue-head exclusion read subdivision codes for
 *   US, CA and AU from codex tables while a planetary source sat in the admin database. The check makes
 *   every such branch declare itself.
 *
 *   It reports seven forms, each a literal beside an operand whose name states what it holds:
 *
 *   - `comparison`: a two-capital code against a country operand, `row.country === "US"`.
 *   - `lowercase`: a two-lowercase-letter code against a country operand, `country === "fr"`.
 *   - `case-call`: either spelling against a country operand inside `.toUpperCase()` or `.toLowerCase()`.
 *   - `locale-tag`: a language-region tag whose region the codex lists, `locale === "en-US"`.
 *   - `street-locale`: a two-lowercase-letter literal against an operand whose name ends in `locale`.
 *   - `switch-case`: a `case` label of any form above, in a `switch` on such an operand.
 *   - `default`: a code, a tag or a list of one or two codes as the fallback of a country or locale operand
 *     (`country ?? "US"`, a parameter `country = "US"`), or held by a binding whose name reads as a default
 *     country or a country collection (`DEFAULT_COUNTRIES = ["US"]`).
 *     `country-literal-sets` reports the list of three or more codes such a binding holds.
 *
 *   A country operand is a name that ends in `country`, `countryCode`, `iso2` or `cc`, or the region
 *   read from a tag with `locale.split("-")[1]`.
 *   A locale operand is a name that ends in `locale`.
 *
 *   A branch is admitted in three places. A module under a country directory or with a country file name is
 *   per-country code by its home ({@linkcode isCountryHome}). A module under `packages/codex/` holds
 *   per-country data by definition. Anywhere else, the statement's line or the comment block above it
 *   contains `country-branch: <reason>`, which states why the rule is one country's and what planetary
 *   source would replace it. A marker above a `switch` covers each of its cases.
 *
 *   A directory that spells a region in letters that are another country's code is read as that country's
 *   home: `postcode/ni/` holds Northern Ireland's code and is admitted as Nicaragua's.
 *
 *   `ZZ` is the synthetic-row country rather than a place, so a literal of it is admitted.
 *   Test sources and generated modules are skipped.
 *
 *   The check reads names and literals and resolves no types, so it can't see:
 *
 *   - A country held by a name of another shape: `c === "US"`, `base === "en"`, `slug === "ca"`.
 *   - A literal held by a constant: `country === HOME`.
 *   - Membership and prefix tests: `COVERED.has(country)`, `["US", "CA"].includes(country)`,
 *     `locale.startsWith("en")`.
 *   - A table keyed by country, `{ US: …, GB: … }[country]`, and a `Map` of the same.
 *   - A script or weights family, `family === "cjk"`.
 *   - A function, constant or module with a country in its name, such as `recognizeUSRegions`.
 *   - A literal passed as a country argument, `lookup(row, "US")`, and an object property `country: "US"`.
 */

import { hasCountry, worldCountries } from "@mailwoman/codex/country/sets"
import { relative } from "path-ts"
import ts from "typescript"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#repo-health/check"
import { parseContextSource, readContextSources } from "#repo-health/context"
import { trackedSourcePaths } from "#repo-health/tracked-sources"

/**
 * The marker a shared module writes beside a country branch it keeps on purpose.
 */
export const COUNTRY_BRANCH_MARKER = "country-branch:"

/**
 * The fewest codes that make a hand-typed list a collection `country-literal-sets` reports.
 *
 * A shorter list in a binding that reads as a country collection is a default, and this check reports it.
 */
export const MIN_COLLECTION_CODES = 3

/**
 * A binding or property name that reads as a collection of countries.
 */
export const COUNTRY_COLLECTION_NAME = /country|countries|iso2|(?:^|_)ccs?$|^ccs?(?:_|$)/iu

const UPPERCASE_CODE = /^[A-Z]{2}$/u
const LOWERCASE_CODE = /^[a-z]{2}$/u

/**
 * A language-region tag as BCP 47 spells it, with an optional script subtag: `en-US`, `zh-Hant-TW`.
 *
 * The lowercase spelling a weights directory takes, `en-us`, is read the same.
 */
const LOCALE_TAG = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?-(?<region>[A-Z]{2}|[a-z]{2})$/u

/**
 * The code the corpus writes on a synthetic row that belongs to no country.
 */
const SYNTHETIC_COUNTRY = "ZZ"

/**
 * An operand name the check reads as one country's code.
 */
const COUNTRY_OPERAND = /(?:country|country_?code|country_?iso2|iso2)$|^cc$|[a-z]CC$|_cc$/iu

/**
 * An operand name the check reads as a list of countries, for the default form.
 */
const COUNTRIES_OPERAND = /countries$|country_?codes$/iu

const LOCALE_OPERAND = /locale$/iu

const DEFAULT_NAME = /default/iu

const CASE_CALLS = new Set(["toUpperCase", "toLowerCase", "toLocaleUpperCase", "toLocaleLowerCase"])

const COMPARISONS = new Set<ts.SyntaxKind>([
	ts.SyntaxKind.EqualsEqualsEqualsToken,
	ts.SyntaxKind.ExclamationEqualsEqualsToken,
	ts.SyntaxKind.EqualsEqualsToken,
	ts.SyntaxKind.ExclamationEqualsToken,
])

const FALLBACKS = new Set<ts.SyntaxKind>([ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken])

/**
 * The directory below which a workspace keeps a country's code: one of its four source roots.
 */
const WORKSPACE_SOURCE_ROOT = /^packages\/[^/]+\/(?:lib|sdk|tools|cli)\//u

/**
 * Modules whose two-letter name is a real country code and means something else.
 */
const NOT_A_COUNTRY_MODULE: ReadonlySet<string> = new Set([
	// `IR` is Iran's code, and the module holds the recognizer's intermediate representation.
	"packages/recognizer/lib/ir.ts",
	// `TF` is the French Southern Territories' code, and the module computes term frequency.
	"packages/match/lib/tf.ts",
])

let knownCountries: ReturnType<typeof worldCountries> | null = null

/**
 * Returns whether two letters, in either case, are an ISO 3166-1 alpha-2 code the codex lists.
 */
function isKnownCountry(code: string): boolean {
	knownCountries ??= worldCountries()

	return hasCountry(knownCountries, code.toUpperCase())
}

/**
 * Returns whether a repository-relative path is a per-country home.
 *
 * The codex package is one.
 * So is a module below a workspace source root with a directory or a file name that's a lowercase ISO
 * 3166-1 alpha-2 code the codex lists, such as `packages/corpus/lib/us/` or `postcode/locality/jp.ts`.
 *
 * `packages/core/lib/fs/` is no home because `FS` is no country, and `lib/repo-health/ci/`
 * is none because it sits outside a workspace.
 */
export function isCountryHome(file: string): boolean {
	if (file.startsWith("packages/codex/")) return true

	if (NOT_A_COUNTRY_MODULE.has(file)) return false

	const root = WORKSPACE_SOURCE_ROOT.exec(file)

	if (!root) return false

	const segments = file.slice(root[0].length).split("/")
	const basename = segments.pop()!.replace(/\.tsx?$/u, "")

	return [...segments, basename].some((segment) => LOWERCASE_CODE.test(segment) && isKnownCountry(segment))
}

/**
 * Strips the `as const`, `satisfies`, non-null and parenthesis wrappers around an expression.
 */
function unwrapExpression(node: ts.Expression): ts.Expression {
	let current = node

	while (
		ts.isAsExpression(current) ||
		ts.isSatisfiesExpression(current) ||
		ts.isParenthesizedExpression(current) ||
		ts.isNonNullExpression(current)
	) {
		current = current.expression
	}

	return current
}

/**
 * Returns the array literal an expression holds directly or as `new Set([...])`, or `null`.
 */
export function collectionLiteral(node: ts.Expression): ts.ArrayLiteralExpression | null {
	const inner = unwrapExpression(node)

	if (ts.isArrayLiteralExpression(inner)) return inner

	if (
		ts.isNewExpression(inner) &&
		ts.isIdentifier(inner.expression) &&
		/^(?:Readonly)?Set$/u.test(inner.expression.text) &&
		inner.arguments?.[0]
	) {
		const argument = unwrapExpression(inner.arguments[0])

		return ts.isArrayLiteralExpression(argument) ? argument : null
	}

	return null
}

/**
 * Returns whether `node` has the `country-branch:` marker.
 *
 * The marker counts on the node's own lines, on the lines of its statement before it,
 * or anywhere in the comment block right above that statement, case clause or class member.
 * A wrapped statement or a two-line reason is therefore read the same as a one-line one.
 *
 * @param source A tree parsed with parent nodes set.
 */
export function isMarkedCountryBranch(source: ts.SourceFile, node: ts.Node): boolean {
	const text = source.getFullText()
	const lineStarts = source.getLineStarts()
	const lineOf = (position: number) => source.getLineAndCharacterOfPosition(position).line + 1

	// The text of a one-based line, read from the parsed source's line table rather than a split copy.
	const lineText = (line: number): string =>
		line < 1 || line > lineStarts.length ? "" : text.slice(lineStarts[line - 1], lineStarts[line] ?? text.length)

	let holder: ts.Node = node

	while (holder.parent && !ts.isStatement(holder) && !ts.isCaseClause(holder) && !ts.isClassElement(holder)) {
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

/**
 * The shape of a reported branch, and the reason the check reads it as one country's.
 */
const CountryBranchForm = {
	Comparison: "comparison",
	Lowercase: "lowercase",
	CaseCall: "case-call",
	LocaleTag: "locale-tag",
	StreetLocale: "street-locale",
	SwitchCase: "switch-case",
	Default: "default",
} as const

type CountryBranchForm = (typeof CountryBranchForm)[keyof typeof CountryBranchForm]

/**
 * What an operand's spelling states it holds.
 */
interface Operand {
	/**
	 * The last name of the access chain, or `null` when the operand is no name.
	 */
	name: string | null
	/**
	 * Whether the name sits inside a case-folding call.
	 */
	caseCall: boolean
}

/**
 * Reads the name an operand ends in, through wrappers, a `??` or `||` fallback,
 * and `.trim()` or a case-folding call.
 */
function readOperand(node: ts.Expression): Operand {
	let current = unwrapExpression(node)
	let caseCall = false

	for (;;) {
		if (ts.isBinaryExpression(current) && FALLBACKS.has(current.operatorToken.kind)) {
			current = unwrapExpression(current.left)
		} else if (
			ts.isCallExpression(current) &&
			ts.isPropertyAccessExpression(current.expression) &&
			(CASE_CALLS.has(current.expression.name.text) || current.expression.name.text === "trim")
		) {
			caseCall ||= CASE_CALLS.has(current.expression.name.text)
			current = unwrapExpression(current.expression.expression)
		} else {
			break
		}
	}

	// The region of a tag, `locale.split("-")[1]`, is a country whatever the tag's holder is called.
	if (
		ts.isElementAccessExpression(current) &&
		ts.isCallExpression(current.expression) &&
		ts.isPropertyAccessExpression(current.expression.expression) &&
		current.expression.expression.name.text === "split" &&
		LOCALE_OPERAND.test(readOperand(current.expression.expression.expression).name ?? "")
	) {
		return { name: "country", caseCall }
	}

	if (ts.isIdentifier(current)) return { name: current.text, caseCall }

	if (ts.isPropertyAccessExpression(current)) return { name: current.name.text.replace(/^#/u, ""), caseCall }

	if (ts.isElementAccessExpression(current) && ts.isStringLiteralLike(current.argumentExpression)) {
		return { name: current.argumentExpression.text, caseCall }
	}

	return { name: null, caseCall }
}

function isCountryCode(text: string): boolean {
	return (UPPERCASE_CODE.test(text) || LOWERCASE_CODE.test(text)) && text.toUpperCase() !== SYNTHETIC_COUNTRY
}

function isRegionTag(text: string): boolean {
	const region = LOCALE_TAG.exec(text)?.groups?.region

	return region != null && isKnownCountry(region)
}

/**
 * Returns the form of a literal compared with an operand, or `null` when the pair is no country branch.
 */
function comparisonForm(literal: ts.Expression, operand: ts.Expression): CountryBranchForm | null {
	if (!ts.isStringLiteralLike(literal)) return null

	const { name, caseCall } = readOperand(operand)

	if (name == null) return null

	if (isRegionTag(literal.text)) {
		return LOCALE_OPERAND.test(name) || COUNTRY_OPERAND.test(name) ? CountryBranchForm.LocaleTag : null
	}

	if (!isCountryCode(literal.text)) return null

	if (COUNTRY_OPERAND.test(name)) {
		if (caseCall) return CountryBranchForm.CaseCall

		return LOWERCASE_CODE.test(literal.text) ? CountryBranchForm.Lowercase : CountryBranchForm.Comparison
	}

	return LOCALE_OPERAND.test(name) && LOWERCASE_CODE.test(literal.text) ? CountryBranchForm.StreetLocale : null
}

/**
 * Returns whether an expression is a literal a default country takes: one known code
 * in capitals, or a list of known codes shorter than `maxCodes`.
 */
function isDefaultCountryValue(node: ts.Expression, maxCodes: number): boolean {
	const inner = unwrapExpression(node)

	if (ts.isStringLiteralLike(inner)) {
		return UPPERCASE_CODE.test(inner.text) && inner.text !== SYNTHETIC_COUNTRY && isKnownCountry(inner.text)
	}

	const array = collectionLiteral(inner)

	return (
		array != null &&
		array.elements.length > 0 &&
		array.elements.length < maxCodes &&
		array.elements.every(
			(element) => ts.isStringLiteralLike(element) && isCountryCode(element.text) && isKnownCountry(element.text)
		)
	)
}

/**
 * Returns whether `value` is a hard-coded fallback for the binding or operand `name`.
 */
function isDefaultFor(name: string, value: ts.Expression): boolean {
	if (COUNTRY_OPERAND.test(name) || COUNTRIES_OPERAND.test(name)) {
		return isDefaultCountryValue(value, Number.POSITIVE_INFINITY)
	}

	if (!LOCALE_OPERAND.test(name)) return false

	const inner = unwrapExpression(value)

	return ts.isStringLiteralLike(inner) && (isRegionTag(inner.text) || LOWERCASE_CODE.test(inner.text))
}

function declaredName(node: ts.Node): string | null {
	if (
		(ts.isVariableDeclaration(node) ||
			ts.isPropertyAssignment(node) ||
			ts.isPropertyDeclaration(node) ||
			ts.isParameter(node) ||
			ts.isBindingElement(node)) &&
		(ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) || ts.isPrivateIdentifier(node.name))
	) {
		return node.name.text.replace(/^#/u, "")
	}

	return null
}

/**
 * Returns whether a declaration holds a hard-coded default country.
 *
 * A parameter or destructuring default counts by the name it binds.
 * A variable or property counts when its name reads as a default (`DEFAULT_COUNTRY`),
 * or as a country collection holding a list too short for `country-literal-sets` to report.
 */
function isDefaultDeclaration(node: ts.Node): boolean {
	const name = declaredName(node)
	const initializer = (node as { initializer?: ts.Expression }).initializer

	if (name == null || !initializer) return false

	if (ts.isParameter(node) || ts.isBindingElement(node)) return isDefaultFor(name, initializer)

	if (DEFAULT_NAME.test(name)) {
		const inner = unwrapExpression(initializer)

		// A bare `defaultLocale: "en"` is a site's interface language, so a locale default counts only as a tag.
		if (LOCALE_OPERAND.test(name)) return ts.isStringLiteralLike(inner) && isRegionTag(inner.text)

		if (isDefaultFor(name, initializer)) return true
	}

	return (
		COUNTRY_COLLECTION_NAME.test(name) &&
		collectionLiteral(initializer) != null &&
		isDefaultCountryValue(initializer, MIN_COLLECTION_CODES)
	)
}

/**
 * One country branch and its location.
 */
interface CountryBranch {
	file: string
	line: number
	form: CountryBranchForm
	text: string
}

/**
 * Returns every country branch in the given sources that sits outside a per-country home
 * and has no `country-branch:` marker on its statement or the comment block above it.
 *
 * @param files Each source's repository-relative path and its tree, parsed with parent nodes set.
 */
function findCountryBranches(files: ReadonlyArray<{ file: string; source: ts.SourceFile }>): CountryBranch[] {
	const found: CountryBranch[] = []

	for (const { file, source } of files) {
		if (isCountryHome(file)) continue

		const report = (node: ts.Node, form: CountryBranchForm): void => {
			if (isMarkedCountryBranch(source, node)) return

			// A case clause's text runs to the next clause, so it's reported by its label.
			const text = ts.isCaseClause(node) ? `case ${node.expression.getText(source)}` : node.getText(source)

			found.push({
				file,
				line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
				form,
				text: text.replaceAll(/\s+/gu, " "),
			})
		}

		const visit = (node: ts.Node): void => {
			if (ts.isBinaryExpression(node) && COMPARISONS.has(node.operatorToken.kind)) {
				const form = comparisonForm(node.right, node.left) ?? comparisonForm(node.left, node.right)

				if (form) {
					report(node, form)
				}
			} else if (ts.isBinaryExpression(node) && FALLBACKS.has(node.operatorToken.kind)) {
				const { name } = readOperand(node.left)

				if (name != null && isDefaultFor(name, node.right)) {
					report(node, CountryBranchForm.Default)
				}
			} else if (ts.isSwitchStatement(node) && !isMarkedCountryBranch(source, node.expression)) {
				// A marker above the `switch` covers every case, and a marker above one case covers that case.
				for (const clause of node.caseBlock.clauses) {
					if (ts.isCaseClause(clause) && comparisonForm(clause.expression, node.expression)) {
						report(clause, CountryBranchForm.SwitchCase)
					}
				}
			} else if (isDefaultDeclaration(node)) {
				report(node, CountryBranchForm.Default)
			}

			node.forEachChild(visit)
		}

		source.forEachChild(visit)
	}

	return found
}

const REMEDY =
	`Move the rule into per-country data (a codex table or a module under a country directory), or write ` +
	`\`// ${COUNTRY_BRANCH_MARKER} <reason>\` on the line above stating why the rule is one country's and which ` +
	`planetary source would replace it.`

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
		const paths = (await trackedSourcePaths(context, { existingOnly: true })).filter((path) => {
			const file = relative(context.repoRoot, path)

			// A reason comment in generated output would be removed by the next generation.
			return !/\/test\/|\.test\.tsx?$|\.generated\.tsx?$/u.test(file) && !isCountryHome(file)
		})

		const texts = await readContextSources(context, paths)
		const files: { file: string; source: ts.SourceFile }[] = []

		for (const [index, path] of paths.entries()) {
			// Most files hold neither a quoted code nor a quoted tag, so a pattern search skips them before parsing.
			if (!/["'`][A-Za-z]{2,3}(?:-[A-Za-z]{2,4}){0,2}["'`]/u.test(texts[index]!)) continue

			files.push({
				file: relative(context.repoRoot, path),
				source: await parseContextSource(context, path, { setParentNodes: true }),
			})
		}

		return findCountryBranches(files).map((branch): Diagnostic => ({
			severity: DiagnosticSeverity.Error,
			message:
				branch.form === CountryBranchForm.Default
					? `\`${branch.text}\` makes one country the default for every caller. ${REMEDY}`
					: `\`${branch.text}\` gives one country a path the rest of the planet does not get (${branch.form}). ${REMEDY}`,
			file: branch.file,
			line: branch.line,
			details: null,
		}))
	},
}
