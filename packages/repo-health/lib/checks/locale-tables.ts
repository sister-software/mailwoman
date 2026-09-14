/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Every country→locale table agrees with the locales `release.config.json` ships.
 *
 *   Four tables map an ISO country code to a locale, each written by hand, and `release.config.json` is the one
 *   that decides what ships. Adding a locale means editing the config and then remembering four other files; the
 *   one that is forgotten fails silently, because a table that does not name a country simply answers nothing for
 *   it and every consumer treats that as an absence rather than an error.
 *
 *   TWO INVARIANTS, chosen because each has a failure nothing else reports.
 *
 *   COMPLETENESS binds one table. `WEIGHTS_PACKAGE_BY_COUNTRY` answers "which locale package scopes this country"
 *   for the coverage census, so a shipping locale missing from it is reported to the operator as a country with no
 *   weights. `ja-jp` and `zh-cn` were in that state: both are in the release list, both ship, and the census named
 *   neither. The other three tables are deliberate SUBSETS — the gauntlet's overlay routing excludes the base
 *   locale, the invariance suite lists the countries its fixture rows carry, and the autocomplete ladder's FST
 *   table is country-scoped by construction — so completeness is not asked of them.
 *
 *   AGREEMENT binds all four. A country key must equal its locale's region subtag: `GB` takes `en-GB`, never
 *   `de-DE`. A table is read by key, so a transposed pair routes a whole country's rows through another country's
 *   weights and reports a plausible score for the wrong artifact.
 *
 *   WHAT IS DELIBERATELY NOT CHECKED: a table naming a locale that does not ship. `FST_LOCALE_BY_COUNTRY` carries
 *   `KR: "ko-kr"` ahead of the Korean package, and the ladder resolves an FST by path and answers nothing when the
 *   file is absent, so the forward-looking entry costs a warning line and no wrong reading. An error there would
 *   fire for the length of every arc that names its locale before shipping it.
 *
 *   The config is read rather than imported: `release.config.json` sits at the repository root, and a package that
 *   reached it at runtime would break the moment it ran from a published tarball.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { readReleaseConfig } from "@mailwoman/core/release-config"
import { resolvePath } from "path-ts"
import ts from "typescript"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"

interface LocaleTable {
	/**
	 * Repository-relative path of the module declaring it.
	 */
	file: string
	/**
	 * The declaration's name, as exported.
	 */
	name: string
	/**
	 * Whether every shipping locale must appear. False for a table that is a deliberate subset; the reason each one is a
	 * subset is in this file's header, not repeated per row.
	 */
	complete: boolean
}

const LOCALE_TABLES: readonly LocaleTable[] = [
	{ file: "packages/mailwoman/lib/coverage/census.ts", name: "WEIGHTS_PACKAGE_BY_COUNTRY", complete: true },
	{
		file: "packages/mailwoman/lib/eval-harness/gauntlet/routing.ts",
		name: "OVERLAY_LOCALE_BY_COUNTRY",
		complete: false,
	},
	{ file: "packages/mailwoman/lib/eval-harness/invariance/parser.ts", name: "COUNTRY_TO_LOCALE", complete: false },
	{
		file: "packages/mailwoman/lib/eval-harness/autocomplete-ladder.ts",
		name: "FST_LOCALE_BY_COUNTRY",
		complete: false,
	},
]

interface TableEntry {
	country: string
	locale: string
	line: number
}

/**
 * The `(country, locale)` pairs a declaration holds, whether it is written as an object literal or as `new Map([[…]])`.
 * Both spellings are in use and neither is worth normalizing for this check's sake.
 */
function readTableEntries(source: ts.SourceFile, name: string): TableEntry[] | undefined {
	let entries: TableEntry[] | undefined
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

	const text = (node: ts.Node): string => node.getText(source).replaceAll(/^["'`]|["'`]$/g, "")

	const visit = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer) {
			const initializer = unwrap(node.initializer)

			if (initializer && ts.isObjectLiteralExpression(initializer)) {
				entries = initializer.properties.flatMap((property) =>
					ts.isPropertyAssignment(property) && property.name
						? [
								{
									country: text(property.name),
									locale: text(property.initializer),
									line: lineOf(property.getStart(source)),
								},
							]
						: []
				)

				return
			}

			// `new Map([["US", "en-us"], …])`
			if (initializer && ts.isNewExpression(initializer)) {
				const list = unwrap(initializer.arguments?.[0])

				if (list && ts.isArrayLiteralExpression(list)) {
					entries = list.elements.flatMap((element) => {
						const pair = unwrap(element)

						if (!pair || !ts.isArrayLiteralExpression(pair) || pair.elements.length < 2) return []

						return [
							{
								country: text(pair.elements[0]!),
								locale: text(pair.elements[1]!),
								line: lineOf(pair.getStart(source)),
							},
						]
					})
				}

				return
			}
		}

		node.forEachChild(visit)
	}

	source.forEachChild(visit)

	return entries
}

/**
 * Every locale `release.config.json` ships: the Latin list plus each character-path family's overlays. The two halves
 * are separate fields, and a reader that takes only `locales` misses the CJK overlays entirely.
 */
export function shippingLocales(config: {
	locales: string[]
	charWeights?: Record<string, { overlays?: string[] }>
}): Set<string> {
	const locales = new Set(config.locales)

	for (const family of Object.values(config.charWeights ?? {})) {
		for (const overlay of family.overlays ?? []) {
			locales.add(overlay)
		}
	}

	return locales
}

/**
 * The `locale-tables` check: one error per shipping locale a complete table omits, and one per entry whose country key
 * disagrees with its locale's region subtag.
 */
export const localeTablesCheck: RepoCheck = {
	id: "locale-tables",
	description: "Every country→locale table agrees with the locales release.config.json ships.",
	async run(context) {
		const config = await readReleaseConfig(context.repoRoot)
		const shipping = shippingLocales(config)
		const diagnostics: Diagnostic[] = []

		for (const table of LOCALE_TABLES) {
			const source = ts.createSourceFile(
				table.file,
				await readLocalTextFile(resolvePath(context.repoRoot, table.file)),
				ts.ScriptTarget.ESNext,
				true,
				table.file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
			)

			const entries = readTableEntries(source, table.name)

			if (!entries) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `${table.name} is not declared in this file as an object literal or a Map — this check cannot read it, and the table it names is unguarded`,
					file: table.file,
				})

				continue
			}

			for (const entry of entries) {
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

			if (!table.complete) continue

			const named = new Set(entries.map((entry) => entry.locale.toLowerCase()))

			for (const locale of [...shipping].toSorted()) {
				if (named.has(locale.toLowerCase())) continue

				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `release.config.json ships ${locale} and ${table.name} does not name it — every consumer reads the absence as a country with no weights package rather than as a missing row`,
					file: table.file,
				})
			}
		}

		return diagnostics
	},
}
