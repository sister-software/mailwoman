/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Every country→locale table keys each locale by its own region subtag.
 *
 *   A table is read by key, so a transposed pair fails silently: it answers a locale for the country asked
 *   about, and every consumer treats a plausible answer as the right one.
 *
 *   Tables are discovered rather than listed, because a check that names its subjects cannot see a table somebody
 *   adds. A declaration qualifies when at least two entries pair a country code with a locale tag and those are at
 *   least half of what it holds.
 *
 *   A table naming a locale that does not ship is deliberately not an error: `FST_LOCALE_BY_COUNTRY` carries
 *   `KR: "ko-kr"` ahead of the Korean package, and the ladder resolves an FST by path and returns no answer when
 *   the file is absent, so the forward-looking entry costs a warning line and no wrong reading.
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
 * The threshold for recognizing a country→locale map: at least two entries pair a country
 * code with a locale tag, and those are at least half of what the declaration holds.
 *
 * Both halves are required — two pairs alone admits a table of something else carrying
 * a couple, and the ratio alone admits a two-entry map of anything.
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
	// `existingOnly` because this walk opens every path it is given, and a staged rename
	// the index still names would throw ENOENT for a reason unrelated to the tables.
	const sources = (await trackedSourcePaths(context, { existingOnly: true }))
		.map((path) => relative(context.repoRoot, path))
		.filter((file) => !/\/test\/|\.test\.tsx?$/u.test(file))

	const tables: LocaleTable[] = []

	for (const file of sources) {
		const text = await readLocalTextFile(resolvePath(context.repoRoot, file))

		// Cheap reject before parsing: a country→locale map mentions the country or locale somewhere in the file.
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
