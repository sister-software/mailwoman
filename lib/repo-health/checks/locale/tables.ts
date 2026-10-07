/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Every country→locale table keys each locale by its own region subtag.
 *
 *   Consumers look up a locale by country key. A transposed pair can return a plausible locale for the wrong country.
 *
 *   The check discovers tables across the repository. A fixed list would miss tables added later.
 *   A declaration qualifies when at least two entries pair a country code with a locale tag.
 *   Those entries must make up at least half of the declaration.
 *
 *   This check permits a locale entry before its package ships. `FST_LOCALE_BY_COUNTRY` contains `KR: "ko-kr"`
 *   ahead of the Korean package. The ladder resolves an FST by path and returns no answer while the file is absent.
 *   The forward-looking entry produces a warning without returning the wrong locale.
 */

import { relative } from "path-ts"
import ts from "typescript"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck, type RepoContext } from "#repo-health/check"
import { parseContextSource, readContextSources } from "#repo-health/context"
import { trackedSourcePaths } from "#repo-health/tracked-sources"

/**
 * A country code contains two letters.
 * A locale tag contains a two-letter region code.
 */
const COUNTRY_CODE = /^[A-Za-z]{2}$/u
const LOCALE_TAG = /^[a-z]{2}-[A-Za-z]{2}$/u

/**
 * A declaration qualifies as a country-to-locale map when at least two entries
 * pair a country code with a locale tag.
 *
 * Those entries must comprise at least half of the declaration.
 *
 * Both conditions are required.
 * Two pairs by themselves could match an unrelated table with two pairs.
 * The ratio by itself could match any two-entry map.
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
 * Every country→locale map one source declares, in either the object-literal or `new Map([[…]])` spelling.
 */
function readLocaleTables(source: ts.SourceFile, file: string): LocaleTable[] {
	const tables: LocaleTable[] = []
	const lineOf = (position: number) => source.getLineAndCharacterOfPosition(position).line + 1

	const unwrap = (node: ts.Node | null): ts.Node | null => {
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

			if (initializer && ts.isNewExpression(initializer)) {
				const list = unwrap(initializer.arguments?.[0] ?? null)

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
export async function findLocaleTables(context: RepoContext): Promise<LocaleTable[]> {
	// Use `existingOnly` because the walk opens every path it receives.
	// A staged rename can leave the old path in the index and cause an unrelated ENOENT error.
	const sources = (await trackedSourcePaths(context, { existingOnly: true }))
		.map((path) => relative(context.repoRoot, path))
		.filter((file) => !/\/test\/|\.test\.tsx?$/u.test(file))

	const tables: LocaleTable[] = []
	const texts = await readContextSources(context, sources)

	for (const [index, file] of sources.entries()) {
		// Cheap reject before parsing: a country→locale map mentions the country or locale somewhere in the file.
		if (!/COUNTR|LOCALE|[Ll]ocale/u.test(texts[index]!)) continue

		const source = await parseContextSource(context, file, { setParentNodes: true })

		tables.push(...readLocaleTables(source, file))
	}

	return tables
}

/**
 * The `locale-tables` check: one error per entry whose country key disagrees
 * with its locale's region subtag.
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

		return diagnostics
	},
}
