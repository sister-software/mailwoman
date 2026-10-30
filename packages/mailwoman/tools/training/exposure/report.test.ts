/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict, stringifyJSON, orderedJSON } from "@mailwoman/core/json"
import { mtfNode } from "@mailwoman/mtf/tools/sampler/native"
import { IGNORE_INDEX } from "@mailwoman/neural/labels"
import type { AddressSystemRegistry } from "@mailwoman/neural/tools/address-system-registry"
import { describe, expect, test } from "vitest"

import { Row, spansFromComponents } from "./phenomena.ts"
import {
	addressSystemLookup,
	systemsWithMembers,
	buildReport,
	countCanonicalJSONL,
	measuredAt,
	numericShapePairs,
	StageCounter,
	type Stage,
	STAGES,
} from "./report.ts"

const { pythonText } = await mtfNode()

const registry: AddressSystemRegistry = {
	$comment: "",
	systems: [
		{ id: 0, key: "house_number street locality" },
		{ id: 1, key: "street house_number locality" },
	],
	members: [
		{ country: "RU", script: "local", system: 1 },
		{ country: "RU", script: "latin", system: 0 },
		{ country: "IN", script: "local", system: 0 },
	],
}

const lookup = addressSystemLookup(registry, pythonText)
const counter = (stage: (typeof STAGES)[number]) => new StageCounter(stage, lookup, pythonText)

const canonical = (raw: string, country: string, components: Record<string, string>) =>
	new Row(raw, country, spansFromComponents(pythonText, raw, components))

const context = { codeRevision: null, measuredAt: "2026-10-29T00:00:00+00:00", registry }

describe("exposure report", () => {
	test("numeric-shape pairs multiply the row counts per width", () => {
		const stage = counter("canonical_rows")

		for (const [country, raw, postcode] of [
			["IN", "Lucknow 226001", "226001"],
			["IN", "Delhi 110004", "110004"],
			["RU", "Тула 300000", "300000"],
		] as const) {
			stage.add(canonical(raw, country, { postcode }))
		}

		expect(Object.fromEntries(numericShapePairs(stage))).toEqual({ "6-digit:IN/RU": 2 })
	})

	test("an unmeasured stage is null and a measured empty one is zero", async () => {
		await using directory = await temporaryDirectory("exposure-")
		const path = directory.path("canonical.jsonl").toString()

		const rows = [
			{
				raw: "12, Ивановка, Тула",
				country: "RU",
				components: { house_number: "12", dependent_locality: "Ивановка", locality: "Тула" },
			},
			{ raw: "Тула", country: "RU", components: { locality: "Калуга" } },
		]

		await writeLocalTextFile(rows.map((row) => stringifyJSON(row)).join("\n") + "\n", path)

		const canonicalStage = await countCanonicalJSONL(counter("canonical_rows"), [path])

		const report = parseJSONStrict<{
			jurisdictions: Record<
				string,
				{ stages: Record<string, unknown>; phenomena: Record<string, Record<string, unknown>> }
			>
			address_systems: { systems: Array<{ rows: unknown }> }
		}>(orderedJSON(buildReport([canonicalStage, counter("eligible_training_rows")], context)))

		const ru = report.jurisdictions["RU"]!

		expect(Object.keys(ru.stages)).toEqual([...STAGES])
		expect(ru.stages["canonical_rows"]).toEqual({ total: 2, unreadable: 1 })
		expect(ru.stages["eligible_training_rows"]).toEqual({ total: 0, unreadable: 0 })
		expect(ru.stages["replayed_draws"]).toBeNull()

		const streetless = ru.phenomena["streetless-premise-identity"]!

		expect(streetless["canonical_rows"]).toEqual({ streetless: 1 })
		expect(streetless["eligible_training_rows"]).toEqual({})
		expect(streetless["replayed_draws"]).toBeNull()
		expect(ru.phenomena["ordering-reverses-with-script"]!["canonical_rows"]).toBeNull()

		expect(report.address_systems.systems.map((s) => s.rows)).toEqual([
			{ canonical_rows: 0, eligible_training_rows: 0 },
			{ canonical_rows: 1, eligible_training_rows: 0 },
		])
	})

	test("a row reads its country's Latin system only when every letter is Latin", () => {
		expect(lookup("RU", "12 Lenina, Tula")).toBe(0)
		expect(lookup("RU", "улица Ленина, 12")).toBe(1)
		expect(lookup("ru ", "Тула")).toBe(1)
		expect(lookup("IN", "Lucknow")).toBe(0)
		expect(lookup("XX", "Lucknow")).toBe(IGNORE_INDEX)
		expect(lookup("", "Lucknow")).toBe(IGNORE_INDEX)
	})

	test("the system table lists each system's members by country and script", () => {
		expect(systemsWithMembers(registry)).toEqual([
			{ id: 0, key: "house_number street locality", members: ["IN/local", "RU/latin"] },
			{ id: 1, key: "street house_number locality", members: ["RU/local"] },
		])
	})

	test("measured_at is Python's isoformat at seconds in UTC", () => {
		expect(measuredAt(new Date("2026-10-29T17:12:13.987Z"))).toBe("2026-10-29T17:12:13+00:00")
	})

	test("a stage outside the pipeline is refused", () => {
		const bogus = "bogus".toString() as Stage

		expect(() => buildReport([new StageCounter(bogus, lookup, pythonText)], context)).toThrow("unknown stages bogus")
	})
})
