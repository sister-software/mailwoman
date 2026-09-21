/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Every country→locale table keys each locale by its own region subtag.
 *
 *   Seven tables map an ISO country code to a locale, each written by hand. A table is read by KEY, so a transposed
 *   pair fails silently: it answers a locale for the country asked about, and every consumer treats a plausible
 *   answer as the right one.
 *
 *   the tables are discovered rather than listed. A check that names its subjects cannot see the eighth table somebody
 *   adds, which is the failure it exists to prevent. A declaration qualifies when at least two of its entries pair
 *   a country code with a locale tag and those are at least half of what it holds — both halves required,
 *   since two pairs alone admits a table of something else carrying a couple, and the ratio alone admits a
 *   two-entry map of anything. The rule finds seven where the first version named four.
 *
 *   one invariant. There were two, and the other is gone because the table it bound is gone.
 *
 *   completeness bound `WEIGHTS_PACKAGE_BY_COUNTRY` — the coverage census's answer to "which locale package scopes
 *   this country", where a missing shipping locale reads to the operator as a country with no weights (`ja-jp` and
 *   `zh-cn` were in exactly that state). That table was a hand-written copy of this config's two lists, which is why
 *   it could disagree at all. It is now derived by `@mailwoman/core/release-config`'s `weightsPackageByCountry`, so
 *   it cannot, and the invariant moved to that derivation's own test. Retired here rather than left binding nothing:
 *   a completeness check whose one table has been deleted reports a clean run.
 *
 *   agreement binds every one. A country key must equal its locale's region subtag: `GB` takes `en-GB`, never
 *   `de-DE`. A table is read by key, so a transposed pair routes a whole country's rows through another country's
 *   weights and reports a plausible score for the wrong artifact.
 *
 *   what is deliberately not checked: a table naming a locale that does not ship. `FST_LOCALE_BY_COUNTRY` carries
 *   `KR: "ko-kr"` ahead of the Korean package, and the ladder resolves an FST by path and answers nothing when the
 *   file is absent, so the forward-looking entry costs a warning line and no wrong reading. An error there would
 *   fire for the length of every arc that names its locale before shipping it.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { relative, resolvePath } from "path-ts"
import ts from "typescript"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"
import { trackedSourcePaths } from "#tracked-sources"

/**
 * A country code, and a locale tag whose region half a country code can be read out of.
 */
const COUNTRY_CODE = /^[A-Za-z]{2}$/u
const LOCALE_TAG = /^[a-z]{2}-[A-Za-z]{2}$/u

/**
 * A declaration is a country→locale map when at least two of its entries pair a country
 * code with a locale tag and those are at least half of what it holds.
 *
 * Discovered rather than listed, because a check that names its subjects cannot
 * see the fifth table somebody adds.
 * The first version named four files. the rule below finds seven, and the three it
 * gained are `corpus`'s `LOCALE_TAG`, `localeFor` and `LOCALE_BY_COUNTRY` — the last of
 * which the constant inventory (#2219) lists as unmeasured.
 *
 * Both halves of the rule are required: two pairs alone admits a table of something else
 * that happens to carry a couple, and the ratio alone admits a two-entry map of anything.
 */
const MINIMUM_LOCALE_PAIRS = 2

interface TableEntry {
	country: string
	locale: string
	line: number
}

export interface LocaleTable {
	name: string
	file: string
	line: number
	entries: TableEntry[]
}

/**
 * Every country→locale map one source declares, whether written as an object literal or as `new Map([[…]])`.
 *
 * Both spellings are in use and neither is worth normalizing for this check's sake.
 */
function readLocaleTables(source: ts.SourceFile, file: string): LocaleTable[] {
	const tables: LocaleTable[] = []
	const lineOf = (position: number) => source.getLineAndCharacterOfPosition(position).line + 1

	const unwrap = (node: ts.Node | undefined): ts.Node | undefined => {
		let current = node

		while (
			current &&
			(ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current))
		) {
			current = current.expression
		}

		return current
	}

	const text = (node: ts.Node): string => node.getText(source).replaceAll(/^["'`]|["'`]$/gu, "")

	const visit = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
			const initializer = unwrap(node.initializer)
			const pairs: TableEntry[] = []

			if (initializer && ts.isObjectLiteralExpression(initializer)) {
				for (const property of initializer.properties) {
					if (!ts.isPropertyAssignment(property) || !property.name) continue

					pairs.push({
						country: text(property.name),
						locale: text(property.initializer),
						line: lineOf(property.getStart(source)),
					})
				}
			}

			// `new Map([["US", "en-us"], …])`
			if (initializer && ts.isNewExpression(initializer)) {
				const list = unwrap(initializer.arguments?.[0])

				if (list && ts.isArrayLiteralExpression(list)) {
					for (const element of list.elements) {
						const pair = unwrap(element)

						if (!pair || !ts.isArrayLiteralExpression(pair) || pair.elements.length < 2) continue

						pairs.push({
							country: text(pair.elements[0]!),
							locale: text(pair.elements[1]!),
							line: lineOf(pair.getStart(source)),
						})
					}
				}
			}

			const localePairs = pairs.filter((pair) => COUNTRY_CODE.test(pair.country) && LOCALE_TAG.test(pair.locale))

			if (localePairs.length >= MINIMUM_LOCALE_PAIRS && localePairs.length * 2 >= pairs.length) {
				tables.push({ name: node.name.text, file, line: lineOf(node.getStart(source)), entries: localePairs })
			}
		}

		node.forEachChild(visit)
	}

	source.forEachChild(visit)

	return tables
}

/**
 * Every country→locale map in the tracked non-test sources.
 */
export async function findLocaleTables(context: {
	repoRoot: string
	trackedFiles: readonly string[]
}): Promise<LocaleTable[]> {
	// `existingOnly`: the index can name a file the working tree no longer has — a rename staged
	// and not committed is enough — and this walk opens every path it is given, so the absent
	// one throws enoent and the check fails for a reason that has nothing to do with the tables.
	// Every other tracked-file walk in this package passes it.
	const sources = (await trackedSourcePaths(context, { existingOnly: true }))
		.map((path) => relative(context.repoRoot, path))
		.filter((file) => !/\/test\/|\.test\.tsx?$/u.test(file))

	const tables: LocaleTable[] = []

	for (const file of sources) {
		const text = await readLocalTextFile(resolvePath(context.repoRoot, file))

		// Cheap reject before parsing: a country→locale map names one or the other somewhere in the file.
		if (!/COUNTR|LOCALE|[Ll]ocale/u.test(text)) continue

		const source = ts.createSourceFile(
			file,
			text,
			ts.ScriptTarget.ESNext,
			true,
			file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
		)

		tables.push(...readLocaleTables(source, file))
	}

	return tables
}

/**
 * The `locale-tables` check: one error per entry whose country key disagrees
 * with its locale's region subtag.
 *
 * Completeness was the second invariant and is retired — see the file header,
 * and the note where it used to run.
 */
export const localeTablesCheck: RepoCheck = {
	id: "locale-tables",
	description: "Every country→locale table keys each locale by its own region subtag.",
	async run(context) {
		const tables = await findLocaleTables(context)
		const diagnostics: Diagnostic[] = []

		for (const table of tables) {
			for (const entry of table.entries) {
				const region = entry.locale.split("-")[1]?.toUpperCase()

				if (region && region !== entry.country.toUpperCase()) {
					diagnostics.push({
						severity: DiagnosticSeverity.Error,
						message: `${table.name} maps ${entry.country} to ${entry.locale}, whose region is ${region} — a table read by country key routes that country's rows through another country's artifact`,
						file: table.file,
						line: entry.line,
					})
				}
			}
		}

		// completeness is no longer asked of any table here — see the file header.
		// It bound `WEIGHTS_PACKAGE_BY_COUNTRY`, which is now derived from `release.config.json` by
		// `@mailwoman/core/release-config`'s `weightsPackageByCountry` and cannot disagree with it.
		// The invariant moved to that derivation's own test, where a shipping locale it fails to name
		// is a failing assertion rather than a lint finding about a copy nobody should write again.
		// With it went this check's only read of the config.
		return diagnostics
	},
}
