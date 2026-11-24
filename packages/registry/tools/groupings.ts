// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Normalizes the country groupings from their pinned sources into one groupings table
 *   and one table of membership intervals.
 *
 *   An organization's members are Wikidata statements through the property its
 *   definition names, P463 ("member of") or P527 ("has part(s)").
 *   The other property is read too, and the report lists the codes on which the two disagree.
 *
 *   A classification's members come from its publisher's list: the World Bank's country API,
 *   and the IMF advanced-economy list in a pinned Wikipedia revision.
 *
 *   A grouping whose statements can't be classified is kept with the reasons in `blockedBy`,
 *   and its members are left out of the membership table.
 *   It never reads as a grouping with no members.
 */

import { stringifyJSON } from "@mailwoman/core/values/json"

import type { GroupingDefinitions } from "#sdk/sources"
import type { SPARQLResults } from "#tools/normalize"
import type { CountryRecord, GroupingRecord, MemberCodeStatus, MembershipRole, MembershipRow, StatedDate } from "#types"

/**
 * The version of the rules below.
 * A change that moves a row's bytes moves this number.
 */
export const GROUPING_NORMALIZATION_VERSION = 1

export interface NormalizedGroupings {
	profile: string
	normalizationVersion: number
	groupings: GroupingRecord[]
	records: MembershipRow[]
}

/**
 * What the normalizer found about one grouping that the tables don't hold.
 */
export interface GroupingReport {
	/**
	 * Membership rows by role, before any were left out.
	 */
	roles: Partial<Record<MembershipRole, number>>
	/**
	 * Rows whose statement states no role, read as `member`.
	 */
	withoutRole: number
	withoutStart: number
	/**
	 * Wikidata members whose item holds no ISO 3166-1 record, such as a kingdom item beside its country item.
	 */
	uncoded: string[]
	/**
	 * For an organization: codes the selected property states and the other property doesn't, and the reverse.
	 */
	crossCheck: { property: string; otherStates: number; onlySelected: string[]; onlyOther: string[] } | null
}

export interface GroupingSources {
	definitions: GroupingDefinitions
	countries: readonly CountryRecord[]
	p463: SPARQLResults
	p527: SPARQLResults
	worldbank: unknown
	worldbankAsOf: string | null
	wikitext: string
	wikitextAsOf: string | null
	profile: string
}

const ENTITY = "http://www.wikidata.org/entity/"

/**
 * Wikidata's `wikibase:timePrecision` for a date stated to the day.
 */
const DAY_PRECISION = 11

/**
 * Wikidata's `wikibase:timePrecision` for a date stated to the month.
 */
const MONTH_PRECISION = 10

/**
 * Reads a Wikidata time value at its stated precision.
 *
 * Every precision coarser than a month, such as a year, decade or century,
 * reads as the year Wikidata stores.
 * A membership date stated that coarsely still places the change within that year.
 */
export function statedDate(value: string | undefined, precision: string | undefined): StatedDate | null {
	if (!value) return null

	const match = /^\+?(\d{4})-(\d{2})-(\d{2})/.exec(value)

	if (!match) throw new Error(`unreadable Wikidata time ${value}`)

	const [, year, month, day] = match
	const level = Number(precision)

	if (level >= DAY_PRECISION) return { date: `${year}-${month}-${day}`, precision: "day" }

	if (level === MONTH_PRECISION) return { date: `${year}-${month}-01`, precision: "month" }

	return { date: `${year}-01-01`, precision: "year" }
}

interface Statement {
	org: string
	member: string
	id: string
	roles: string[]
	start: StatedDate | null
	end: StatedDate | null
}

/**
 * Folds the query's rows, one per statement and role, into statements, leaving out deprecated ones.
 */
export function readStatements(results: SPARQLResults): Statement[] {
	const byID = new Map<string, Statement>()

	for (const row of results.results.bindings) {
		if (row["rank"]?.value.endsWith("#DeprecatedRank")) continue

		const id = row["statement"]!.value.replace(`${ENTITY}statement/`, "")
		const role = row["role"]?.value.replace(ENTITY, "")
		const existing = byID.get(id)

		if (existing) {
			if (role && !existing.roles.includes(role)) {
				existing.roles.push(role)
			}

			continue
		}

		byID.set(id, {
			org: row["org"]!.value.replace(ENTITY, ""),
			member: row["member"]!.value.replace(ENTITY, ""),
			id,
			roles: role ? [role] : [],
			start: statedDate(row["start"]?.value, row["startPrecision"]?.value),
			end: statedDate(row["end"]?.value, row["endPrecision"]?.value),
		})
	}

	return [...byID.values()]
}

/**
 * The code status of an alpha-2 code: its ISO record's status, or `source-extension`
 * for a code no record holds.
 */
function codeStatus(code: string, byAlpha2: ReadonlyMap<string, CountryRecord>): MemberCodeStatus {
	return byAlpha2.get(code)?.status ?? "source-extension"
}

function emptyReport(): GroupingReport {
	return { roles: {}, withoutRole: 0, withoutStart: 0, uncoded: [], crossCheck: null }
}

/**
 * Reads the IMF advanced economies from the "IMF advanced economies" section of the article.
 *
 * The section lists the IMF's economies and then, after a "Plus" line
 * or with a `<sup>d</sup>` mark, the entries the CIA adds.
 * Only the IMF's entries are read.
 *
 * The section's own count ("43 countries and territories") is compared with the entries read,
 * and a difference is returned as a reason to block the grouping.
 */
export function readIMFAdvanced(wikitext: string): { names: string[]; stated: number | null } {
	const start = wikitext.search(/==\s*IMF advanced economies\s*==+/)

	if (start < 0) throw new Error("the pinned article has no IMF advanced economies section")

	// The section ends at the next heading of any level, so a later subsection's list isn't read as the IMF's.
	const rest = wikitext.slice(start + 2)
	const end = rest.search(/\n=+[^=\n]/)
	const section = end < 0 ? rest : rest.slice(0, end)
	const names: string[] = []
	let inAddition = false

	// oxlint-disable-next-line mailwoman/prefer-spliterator -- One article section of about 60 lines, already resident.
	for (const line of section.split("\n")) {
		if (/^Plus\b/.test(line.trim())) {
			inAddition = true

			continue
		}

		if (line.trim() === "}}") {
			inAddition = false

			continue
		}

		if (inAddition || line.includes("<sup>d</sup>")) continue

		const flag = /\{\{flag country\|([^}|]+)(?:\|name=([^}|]+))?\}\}/.exec(line)

		if (line.trimStart().startsWith("*") && flag) {
			names.push((flag[2] ?? flag[1]!).trim())
		}
	}

	const stated = /(\d+) countries and territories are officially listed/.exec(section)

	return { names, stated: stated ? Number(stated[1]) : null }
}

/**
 * Serializes the groupings with one grouping and one membership row per line, so a repin diffs by row.
 */
export function formatGroupings(normalized: NormalizedGroupings): string {
	const lines = (rows: readonly unknown[]): string => rows.map((row) => `\t\t${stringifyJSON(row)}`).join(",\n")

	return (
		`{\n\t"profile": ${stringifyJSON(normalized.profile)},\n` +
		`\t"normalizationVersion": ${normalized.normalizationVersion},\n` +
		`\t"groupings": [\n${lines(normalized.groupings)}\n\t],\n` +
		`\t"records": [\n${lines(normalized.records)}\n\t]\n}\n`
	)
}

interface WorldBankCountry {
	id: string
	iso2Code: string
	incomeLevel: { id: string }
}

/**
 * Normalizes every declared grouping.
 *
 * Returns the tables and a report per grouping for the coverage declaration.
 */
export function normalizeGroupings(sources: GroupingSources): {
	normalized: NormalizedGroupings
	reports: Record<string, GroupingReport>
} {
	const byEntity = new Map(sources.countries.map((record) => [record.entityID.replace("wikidata:", ""), record]))
	const byAlpha2 = new Map(sources.countries.map((record) => [record.alpha2, record]))
	const byName = new Map(sources.countries.map((record) => [record.name, record]))
	const statements = { P463: readStatements(sources.p463), P527: readStatements(sources.p527) }
	const groupings: GroupingRecord[] = []
	const records: MembershipRow[] = []
	const reports: Record<string, GroupingReport> = {}

	for (const definition of sources.definitions.groupings) {
		const report = emptyReport()
		const blockedBy: string[] = []
		const rows: MembershipRow[] = []
		const source = definition.source
		let label: string
		let asOf: string | null = null

		if (source.type === "wikidata") {
			label = `wikidata:${source.item} ${source.property}`

			const properties = source.property === "both" ? (["P463", "P527"] as const) : [source.property]

			const recordOf = (member: string): CountryRecord | undefined => {
				const alias = sources.definitions.entities[member]

				return alias ? byAlpha2.get(alias) : byEntity.get(member)
			}

			const codesOf = (property: "P463" | "P527"): Set<string> => {
				const codes = new Set<string>()

				for (const statement of statements[property]) {
					if (statement.org !== source.item) continue

					const record = recordOf(statement.member)

					if (record) {
						codes.add(record.alpha2)
					}
				}

				return codes
			}

			for (const statement of properties.flatMap((property) => statements[property])) {
				if (statement.org !== source.item) continue

				const record = recordOf(statement.member)

				if (!record) {
					report.uncoded.push(statement.member)

					continue
				}

				const roles = statement.roles.map((role: string) => sources.definitions.roles[role] ?? null)
				const unknown = statement.roles.filter((role: string) => !sources.definitions.roles[role])

				if (unknown.length) {
					blockedBy.push(`statement ${statement.id} has role ${unknown.join(", ")}, which the role table omits`)

					continue
				}

				const role: MembershipRole = roles.find((value: MembershipRole | null) => value !== "member") ?? "member"

				report.roles[role] = (report.roles[role] ?? 0) + 1

				if (!statement.roles.length) {
					report.withoutRole++
				}

				if (!statement.start) {
					report.withoutStart++
				}

				rows.push({
					grouping: definition.id,
					code: record.alpha2,
					codeStatus: record.status,
					role,
					start: statement.start,
					end: statement.end,
					evidence: `wikidata:${statement.id}`,
				})
			}

			// A cross-check needs a second set of statements.
			// An organization read through both properties has none, and one whose other property
			// states no member is reported with that count rather than with every member listed.
			if (source.property !== "both") {
				const selected = codesOf(source.property)
				const otherProperty = source.property === "P463" ? "P527" : "P463"
				const other = codesOf(otherProperty)

				report.crossCheck = {
					property: otherProperty,
					otherStates: other.size,
					onlySelected: other.size ? [...selected].filter((code) => !other.has(code)).toSorted() : [],
					onlyOther: [...other].filter((code) => !selected.has(code)).toSorted(),
				}
			}
		} else if (source.type === "worldbank-income") {
			label = `worldbank-countries ${source.level}`
			asOf = sources.worldbankAsOf

			const [, countries] = sources.worldbank as [unknown, WorldBankCountry[]]

			for (const country of countries) {
				if (country.incomeLevel.id !== source.level) continue

				report.roles.member = (report.roles.member ?? 0) + 1

				rows.push({
					grouping: definition.id,
					code: country.iso2Code,
					codeStatus: codeStatus(country.iso2Code, byAlpha2),
					role: "member",
					start: null,
					end: null,
					evidence: `worldbank:${country.id}`,
				})
			}
		} else {
			label = "wikipedia-developed-country"
			asOf = sources.wikitextAsOf

			const { names, stated } = readIMFAdvanced(sources.wikitext)

			if (stated !== null && stated !== names.length) {
				blockedBy.push(`the section states ${stated} economies and lists ${names.length}`)
			}

			for (const name of names) {
				const code = source.aliases[name] ?? byName.get(name)?.alpha2

				if (!code) {
					blockedBy.push(`"${name}" matches no ISO record name and no alias`)

					continue
				}

				report.roles.member = (report.roles.member ?? 0) + 1

				rows.push({
					grouping: definition.id,
					code,
					codeStatus: codeStatus(code, byAlpha2),
					role: "member",
					start: null,
					end: null,
					evidence: `wikipedia:${name}`,
				})
			}
		}

		if (!blockedBy.length && !rows.some((row) => row.role === "member")) {
			blockedBy.push(`${label} states no member`)
		}

		groupings.push({ id: definition.id, name: definition.name, kind: definition.kind, source: label, asOf, blockedBy })
		reports[definition.id] = report

		if (!blockedBy.length) {
			records.push(...rows)
		}
	}

	records.sort(
		(a, b) =>
			a.grouping.localeCompare(b.grouping) ||
			a.code.localeCompare(b.code) ||
			(a.start?.date ?? "").localeCompare(b.start?.date ?? "") ||
			a.evidence.localeCompare(b.evidence)
	)

	return {
		normalized: {
			profile: sources.profile,
			normalizationVersion: GROUPING_NORMALIZATION_VERSION,
			groupings,
			records,
		},
		reports,
	}
}
