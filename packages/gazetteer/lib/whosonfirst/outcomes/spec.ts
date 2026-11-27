// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The sources whose own type field an evidence mapping reads.
 *
 * An OSM value is `key=value`, or `key=*` for any value of the key.
 * A GeoNames value is `<feature class>.<feature code>`.
 *
 * A Wikidata value is a class item matched exactly against a record's `instance of`.
 */
export const OutcomeEvidenceSource = {
	GeoNames: "geonames",
	OSM: "osm",
	Wikidata: "wikidata",
} as const

export type OutcomeEvidenceSource = (typeof OutcomeEvidenceSource)[keyof typeof OutcomeEvidenceSource]

/**
 * A source's type-field values, keyed by source.
 */
export type OutcomeEvidence = Partial<Record<OutcomeEvidenceSource, string[]>>

/**
 * One `outcomes/<name>.json` file of `mailwoman/whosonfirst-outcomes`.
 */
export interface OutcomeDefinition {
	"mw:id": number
	"mw:name": string
	"mw:parent": string | null
	"mw:facet": "identity" | "role"
	"mw:status": "current" | "deprecated"
	"mw:superseded_by": string | null
	"mw:concepts": string[]
	"name:eng_p": string[]
	"mw:default_for": string[]
	"mw:evidence": OutcomeEvidence
	"mw:counter_evidence": OutcomeEvidence
	"wof:concordances": Record<string, string>
}

/**
 * One row of the append-only `registry.json`.
 */
export interface OutcomeRegistryRow {
	"mw:id": number
	"mw:name": string
}

/**
 * The inverse of every member's evidence: source, then value, then the member names it implies, sorted.
 */
export type OutcomeEvidenceIndex = Record<OutcomeEvidenceSource, Record<string, string[]>>

/**
 * `data/outcomes-spec-latest.json`, the one file every build reads.
 */
export interface CompiledOutcomeSpec {
	/**
	 * Every definition, ordered by `mw:id`.
	 */
	definitions: OutcomeDefinition[]
	registry: OutcomeRegistryRow[]
	/**
	 * Each placetype with a default, mapped to the member names it defaults to.
	 */
	defaults: Record<string, string[]>
	/**
	 * Each exempt placetype, mapped to its reason.
	 */
	exemptions: Record<string, string>
	evidence: OutcomeEvidenceIndex
	counter_evidence: OutcomeEvidenceIndex
}

/**
 * The block a database manifest and a model card hold: the definitions revision they were built against.
 */
export interface OutcomeSpecPin {
	/**
	 * The definitions repository's git commit.
	 */
	revision: string
	/**
	 * The SHA-256 of the compiled spec at that commit.
	 */
	sha256: string
}
