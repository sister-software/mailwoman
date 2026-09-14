/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Every country→locale table agrees with the locales `release.config.json` ships.
 *
 *   Seven tables map an ISO country code to a locale, each written by hand, and `release.config.json` is the one
 *   that decides what ships. Adding a locale means editing the config and then remembering the others; the one
 *   that is forgotten fails silently, because a table that does not name a country simply answers nothing for it
 *   and every consumer treats that as an absence rather than an error.
 *
 *   THE TABLES ARE DISCOVERED, NOT LISTED. A check that names its subjects cannot see the eighth table somebody
 *   adds, which is the failure it exists to prevent. A declaration qualifies when at least two of its entries pair
 *   a country code with a locale tag AND those are at least half of what it holds — both halves load-bearing,
 *   since two pairs alone admits a table of something else carrying a couple, and the ratio alone admits a
 *   two-entry map of anything. The rule finds seven where the first version named four.
 *
 *   TWO INVARIANTS, chosen because each has a failure nothing else reports.
 *
 *   COMPLETENESS binds one table. `WEIGHTS_PACKAGE_BY_COUNTRY` answers "which locale package scopes this country"
 *   for the coverage census, so a shipping locale missing from it is reported to the operator as a country with no
 *   weights. `ja-jp` and `zh-cn` were in that state: both are in the release list, both ship, and the census named
 *   neither. Every other country→locale map is a deliberate SUBSET — the gauntlet's overlay routing excludes the
 *   base locale, the invariance suite lists the countries its fixture rows carry, and the autocomplete ladder's
 *   FST table is country-scoped by construction — so completeness is not asked of them.
 *
 *   AGREEMENT binds every one. A country key must equal its locale's region subtag: `GB` takes `en-GB`, never
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

/**
 * The one table that must name every shipping locale, by name.
 *
 * Completeness is a claim about this table specifically: it answers "which locale package scopes this country" for the
 * coverage census, so a shipping locale missing from it is reported to the operator as a country with no weights. Every
 * other country→locale map in the tree is a deliberate subset — the gauntlet's overlay routing excludes the base
 * locale, the invariance suite lists the countries its fixture rows carry, the autocomplete ladder's FST table is
 * country-scoped by construction — so completeness is not asked of them.
 */
const MUST_NAME_EVERY_SHIPPING_LOCALE = "WEIGHTS_PACKAGE_BY_COUNTRY"

/**
 * A country code, and a locale tag whose region half a country code can be read out of.
 */
const COUNTRY_CODE = /^[A-Za-z]{2}$/u
const LOCALE_TAG = /^[a-z]{2}-[A-Za-z]{2}$/u

/**
 * A declaration is a country→locale map when at least two of its entries pair a country code with a locale tag AND
 * those are at least half of what it holds.
 *
 * DISCOVERED RATHER THAN LISTED, because a check that names its subjects cannot see the fifth table somebody adds. The
 * first version named four files; the rule below finds seven, and the three it gained are `corpus`'s `LOCALE_TAG`,
 * `localeFor` and `LOCALE_BY_COUNTRY` — the last of which the constant inventory (#2219) lists as unmeasured. Both
 * halves of the rule are load-bearing: two pairs alone admits a table of something else that happens to carry a couple,
 * and the ratio alone admits a two-entry map of anything.
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
 * Every country→locale map one source declares, whether written as an object literal or as `new Map([[…]])`. Both
 * spellings are in use and neither is worth normalizing for this check's sake.
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
	const sources = context.trackedFiles.filter(
		(file) => /\.tsx?$/u.test(file) && !file.endsWith(".d.ts") && !/\/test\/|\.test\.tsx?$/u.test(file)
	)

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

		const census = tables.find((table) => table.name === MUST_NAME_EVERY_SHIPPING_LOCALE)

		if (!census) {
			return [
				...diagnostics,
				{
					severity: DiagnosticSeverity.Error,
					message: `${MUST_NAME_EVERY_SHIPPING_LOCALE} was not found as a country→locale map — the one table completeness is asked of is unreadable, so its absence would pass silently`,
				},
			]
		}

		const named = new Set(census.entries.map((entry) => entry.locale.toLowerCase()))

		for (const locale of [...shipping].toSorted()) {
			if (named.has(locale.toLowerCase())) continue

			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				message: `release.config.json ships ${locale} and ${census.name} does not name it — every consumer reads the absence as a country with no weights package rather than as a missing row`,
				file: census.file,
				line: census.line,
			})
		}

		return diagnostics
	},
}
