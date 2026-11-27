// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { CompiledOutcomeSpec, OutcomeEvidenceSource } from "#outcome/spec"

/**
 * One entry of a record's `mw:outcomes`: a source's assertion or denial of one member.
 */
export interface OutcomeAssertion {
	outcome: string
	stance: "asserts" | "denies"
	/**
	 * The source and its type-field value, such as `geonames:T.ISL`.
	 */
	src: string
}

/**
 * One row of a compiled database's `record_outcome` table, before its record id is attached.
 */
export interface RecordOutcomeRow {
	outcomeID: number
	/**
	 * A source denies the member while a default or another source holds it.
	 * The member stays in the set.
	 */
	contested: boolean
}

/**
 * The compiled spec, indexed for applying evidence to one record at a time.
 */
export interface OutcomeEvidenceTable {
	/**
	 * The members a placetype holds by default, empty for a placetype with no default.
	 */
	defaultsOf(placetype: string | null): readonly string[]

	/**
	 * Every assertion and denial a source's type-field value implies.
	 *
	 * An OSM `key=value` also matches the definitions' `key=*`.
	 */
	assertionsFor(source: OutcomeEvidenceSource, value: string): OutcomeAssertion[]

	/**
	 * The `record_outcome` rows for one record: each asserted member its placetype's defaults
	 * don't already satisfy, and each held member a source denies, marked contested.
	 *
	 * A denial of a member the record doesn't hold writes zero rows, because a source's silence
	 * and its denial of an absent member both leave the effective set unchanged.
	 */
	recordRows(placetype: string | null, assertions: readonly OutcomeAssertion[]): RecordOutcomeRow[]

	/**
	 * The registry number of a member name.
	 */
	idOf(name: string): number
}

/**
 * Index a compiled spec for evidence application.
 *
 * @throws When an assertion's `src` begins `curated:`, because a curated removal takes a
 * member out of the effective set, and the two compiled tables can't state a removal.
 */
export function createOutcomeEvidenceTable(spec: CompiledOutcomeSpec): OutcomeEvidenceTable {
	const ids = new Map(spec.registry.map((row) => [row["mw:name"], row["mw:id"]]))
	const parents = new Map(spec.definitions.map((definition) => [definition["mw:name"], definition["mw:parent"]]))

	const idOf = (name: string): number => {
		const id = ids.get(name)

		if (typeof id !== "number") {
			throw new TypeError(`${name} isn't a member of the outcome vocabulary.`)
		}

		return id
	}

	const lookup = (source: OutcomeEvidenceSource, value: string, stance: OutcomeAssertion["stance"]) => {
		const index = stance === "asserts" ? spec.evidence[source] : spec.counter_evidence[source]
		const keys = [value]

		if (source === "osm" && value.includes("=")) {
			keys.push(`${value.slice(0, value.indexOf("="))}=*`)
		}

		return keys.flatMap((key) => (index[key] ?? []).map((outcome) => ({ outcome, stance, src: `${source}:${value}` })))
	}

	return {
		defaultsOf: (placetype) => (placetype ? (spec.defaults[placetype] ?? []) : []),
		assertionsFor: (source, value) => [...lookup(source, value, "asserts"), ...lookup(source, value, "denies")],
		idOf,
		recordRows(placetype, assertions) {
			const defaults = placetype ? (spec.defaults[placetype] ?? []) : []
			const satisfied = (member: string) => defaults.some((held) => held === member || parents.get(held) === member)
			const denied = new Set<string>()
			const asserted = new Set<string>()

			for (const assertion of assertions) {
				if (assertion.src.startsWith("curated:")) {
					throw new Error(`The curated assertion ${assertion.src} removes a member; the compiled tables can't hold it.`)
				}

				if (assertion.stance === "denies") {
					denied.add(assertion.outcome)
				} else if (!satisfied(assertion.outcome)) {
					asserted.add(assertion.outcome)
				}
			}

			const rows = [...asserted].map((outcome) => ({ outcomeID: idOf(outcome), contested: denied.has(outcome) }))

			for (const held of defaults) {
				if (denied.has(held)) {
					rows.push({ outcomeID: idOf(held), contested: true })
				}
			}

			return rows.toSorted((left, right) => left.outcomeID - right.outcomeID)
		},
	}
}
