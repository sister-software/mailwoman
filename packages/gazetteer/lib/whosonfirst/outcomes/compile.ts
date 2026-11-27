// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import {
	type CompiledOutcomeSpec,
	type OutcomeEvidence,
	OutcomeEvidenceSource,
	type OutcomeEvidenceIndex,
} from "@mailwoman/core/outcome/spec"
import { orderedJSON } from "@mailwoman/core/values/json"

import type { OutcomeDefinitionsInput } from "#whosonfirst/outcomes/definition"

/**
 * The compile step found the definitions in a state it refuses.
 * `refusals` holds one sentence for each.
 */
export class OutcomeCompileError extends Error {
	readonly refusals: readonly string[]

	constructor(refusals: readonly string[]) {
		super(`The outcome definitions don't compile:\n${refusals.map((refusal) => `  ${refusal}`).join("\n")}`)
		this.name = "OutcomeCompileError"
		this.refusals = refusals
	}
}

function emptyIndex(): OutcomeEvidenceIndex {
	return { geonames: {}, osm: {}, wikidata: {} }
}

function invert(index: OutcomeEvidenceIndex, evidence: OutcomeEvidence, name: string): void {
	for (const source of Object.values(OutcomeEvidenceSource)) {
		for (const value of evidence[source] ?? []) {
			;(index[source][value] ??= []).push(name)
		}
	}
}

/**
 * The refusals for the append-only registry: a gap, a reused number, a reused name,
 * and a row of the previous compilation that changed or disappeared.
 */
function registryRefusals(input: OutcomeDefinitionsInput): string[] {
	const refusals: string[] = []
	const nameOf = new Map<number, string>()
	const idOf = new Map<string, number>()

	for (const row of input.registry) {
		const prior = nameOf.get(row["mw:id"])

		if (typeof prior === "string") {
			refusals.push(`registry.json reuses number ${row["mw:id"]} for ${prior} and ${row["mw:name"]}.`)
		}

		if (idOf.has(row["mw:name"])) {
			refusals.push(`registry.json lists ${row["mw:name"]} twice.`)
		}

		nameOf.set(row["mw:id"], row["mw:name"])
		idOf.set(row["mw:name"], row["mw:id"])
	}

	for (let id = 1; id <= input.registry.length; id++) {
		if (!nameOf.has(id)) {
			refusals.push(`registry.json has a gap at number ${id}.`)
		}
	}

	for (const row of input.previousRegistry ?? []) {
		const now = nameOf.get(row["mw:id"])

		if (now !== row["mw:name"]) {
			refusals.push(
				`registry.json changed row ${row["mw:id"]} from ${row["mw:name"]} to ${now ?? "nothing"}; the registry is append-only.`
			)
		}
	}

	return refusals
}

function definitionRefusals(input: OutcomeDefinitionsInput): string[] {
	const refusals: string[] = []
	const registryID = new Map(input.registry.map((row) => [row["mw:name"], row["mw:id"]]))
	const names = new Set(input.definitions.map((definition) => definition["mw:name"]))

	for (const definition of input.definitions) {
		const name = definition["mw:name"]
		const segments = name.split(".")

		if (registryID.get(name) !== definition["mw:id"]) {
			refusals.push(
				`outcomes/${name}.json has mw:id ${definition["mw:id"]}, and registry.json gives ${registryID.get(name) ?? "none"}.`
			)
		}

		if (segments.length > 2) {
			refusals.push(`${name} has more than two levels.`)
		}

		const parent = segments.length === 2 ? segments[0]! : null

		if (definition["mw:parent"] !== parent) {
			refusals.push(`${name} names parent ${definition["mw:parent"]}, and its spelling names ${parent}.`)
		}

		if (parent && !names.has(parent)) {
			refusals.push(`${name} has no definition for its parent ${parent}.`)
		}

		if (definition["mw:status"] === "deprecated" && !names.has(definition["mw:superseded_by"] ?? "")) {
			refusals.push(`${name} is deprecated without a defined mw:superseded_by.`)
		}

		if (name === "place.locality" && definition["mw:evidence"].osm?.includes("place=locality")) {
			refusals.push("OSM place=locality is never evidence for place.locality.")
		}
	}

	for (const row of input.registry) {
		if (!names.has(row["mw:name"])) {
			refusals.push(`registry.json lists ${row["mw:name"]}, which has no definition.`)
		}
	}

	return refusals
}

function placetypeRefusals(input: OutcomeDefinitionsInput, defaults: Record<string, string[]>): string[] {
	const refusals: string[] = []
	const known = new Set(input.placetypes)

	for (const [placetype, members] of Object.entries(defaults)) {
		if (!known.has(placetype)) {
			refusals.push(`${members.join(", ")} default for ${placetype}, which isn't a placetype.`)
		}

		if (placetype in input.exemptions) {
			refusals.push(`${placetype} has a default and an exemption.`)
		}
	}

	for (const placetype of Object.keys(input.exemptions)) {
		if (!known.has(placetype)) {
			refusals.push(`exemptions/placetypes.json exempts ${placetype}, which isn't a placetype.`)
		}
	}

	for (const placetype of input.placetypes) {
		if (!(placetype in defaults) && !(placetype in input.exemptions)) {
			refusals.push(`${placetype} has neither a default nor an exemption.`)
		}
	}

	return refusals
}

/**
 * Compile the definitions into one spec, or throw {@link OutcomeCompileError} with every refusal.
 *
 * The output is ordered: definitions by `mw:id`, and each inverse list by name.
 */
export function compileOutcomeSpec(input: OutcomeDefinitionsInput): CompiledOutcomeSpec {
	const definitions = input.definitions.toSorted((left, right) => left["mw:id"] - right["mw:id"])
	const defaults: Record<string, string[]> = {}
	const evidence = emptyIndex()
	const counterEvidence = emptyIndex()

	for (const definition of definitions) {
		for (const placetype of definition["mw:default_for"]) {
			;(defaults[placetype] ??= []).push(definition["mw:name"])
		}

		invert(evidence, definition["mw:evidence"], definition["mw:name"])
		invert(counterEvidence, definition["mw:counter_evidence"], definition["mw:name"])
	}

	const refusals = [...registryRefusals(input), ...definitionRefusals(input), ...placetypeRefusals(input, defaults)]

	if (refusals.length) throw new OutcomeCompileError(refusals)

	for (const index of [evidence, counterEvidence]) {
		for (const values of Object.values(index)) {
			for (const members of Object.values(values)) {
				members.sort()
			}
		}
	}

	return {
		definitions,
		registry: input.registry.toSorted((left, right) => left["mw:id"] - right["mw:id"]),
		defaults,
		exemptions: input.exemptions,
		evidence,
		counter_evidence: counterEvidence,
	}
}

/**
 * The spec's file text, with keys sorted at every depth, tab indents and one trailing newline.
 * It holds zero timestamps.
 */
export function serializeOutcomeSpec(spec: CompiledOutcomeSpec): string {
	return `${orderedJSON(spec, { indent: "\t", sortKeys: true })}\n`
}
