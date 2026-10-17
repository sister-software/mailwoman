/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONLFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { TextSpliterator } from "spliterator"
import { describe, expect, it } from "vitest"

import { useScratchDir } from "#test-kit"
import {
	dominantScript,
	loadStreetTypeLexicon,
	rowVariety,
	selectVarietySample,
	streetTypeOf,
	writeVarietySample,
	type SelectionKey,
	type VarietySampleReport,
} from "#tools/variety-sample"

const scratch = useScratchDir("variety-sample")

describe("dominantScript", () => {
	it("names the script most letters are written in", () => {
		expect(dominantScript("ул. Ленина 12, Минск")).toBe("Cyrillic")
		expect(dominantScript("Calle Falsa 123")).toBe("Latin")
		expect(dominantScript("Աբովյան փողոց 5")).toBe("Armenian")
		expect(dominantScript("12 34")).toBe("Other")
	})
})

describe("streetTypeOf", () => {
	it("maps a spelling and its abbreviation to one canonical type", async () => {
		const lexicon = await loadStreetTypeLexicon("BY")

		expect(lexicon.languages).toContain("ru")
		expect(streetTypeOf("улица Ленина", lexicon)).not.toBeNull()
		expect(streetTypeOf("ул. Ленина", lexicon)).toBe(streetTypeOf("улица Ленина", lexicon))
		expect(streetTypeOf("Ленина", lexicon)).toBeNull()
	})

	it("reads every language's list for a country whose languages have none", async () => {
		expect((await loadStreetTypeLexicon("AM")).languages).toBe("all")
	})
})

describe("rowVariety", () => {
	it("stratifies by the locality and dependent locality together", async () => {
		const lexicon = await loadStreetTypeLexicon("EE")

		const village = (name: string) =>
			rowVariety(
				{
					raw: `Jüri, ${name}, 94759 Muhu vald`,
					components: { venue: "Jüri", dependent_locality: name, postcode: "94759", locality: "Muhu vald" },
				},
				lexicon
			)

		expect(village("Raugi küla").place).not.toBe(village("Rootsivere küla").place)
		expect(village("Raugi küla").locality).toBe("Muhu vald")
		expect(village("Raugi küla").streetless).toBe(true)
	})
})

describe("selectVarietySample", () => {
	const limits = { perStreet: 2, perPlace: 3, ceiling: 100, seed: 1 }

	it("keeps at most perStreet rows per street and perPlace per place", () => {
		// One place, one street, ten houses: two survive.
		const oneStreet: SelectionKey[] = Array.from({ length: 10 }, () => ({
			place: 0,
			street: 0,
			form: 0,
			postcode: 0,
		}))

		expect(selectVarietySample(oneStreet, limits)).toHaveLength(2)

		// One place, ten streets: the place cap holds.
		const tenStreets: SelectionKey[] = Array.from({ length: 10 }, (_, street) => ({
			place: 0,
			street,
			form: 0,
			postcode: 0,
		}))

		expect(selectVarietySample(tenStreets, limits)).toHaveLength(3)
	})

	it("represents every place before any place twice, and draws a rare form early", () => {
		const keys: SelectionKey[] = []

		// Place 0 has 50 streets of one form and one street of a second form.
		// Places 1..4 have one street each.
		for (let street = 0; street < 50; street++) {
			keys.push({ place: 0, street, form: 0, postcode: street % 5 })
		}

		keys.push({ place: 0, street: 50, form: 1, postcode: 0 })

		for (let place = 1; place <= 4; place++) {
			keys.push({ place, street: 100 + place, form: 0, postcode: 0 })
		}

		const chosen = selectVarietySample(keys, { ...limits, ceiling: 6 })
		const places = new Set(chosen.map((index) => keys[index]!.place))

		expect(chosen).toHaveLength(6)
		expect(places.size).toBe(5)
		expect(chosen.filter((index) => keys[index]!.place === 0)).toHaveLength(2)
		expect(chosen.some((index) => keys[index]!.form === 1)).toBe(true)
	})

	it("is deterministic under a seed", () => {
		const keys: SelectionKey[] = Array.from({ length: 200 }, (_, i) => ({
			place: i % 7,
			street: i,
			form: i % 3,
			postcode: i % 11,
		}))

		expect(selectVarietySample(keys, { ...limits, ceiling: 15 })).toEqual(
			selectVarietySample(keys, { ...limits, ceiling: 15 })
		)
	})
})

describe("writeVarietySample streetless premises", () => {
	it("caps a village's numbered premises as one street's houses, and keeps each named site", async () => {
		const premise = (number: string) => ({
			raw: `${number}, Ивановка, Тула`,
			components: { house_number: number, dependent_locality: "Ивановка", locality: "Тула" },
			country: "RU",
		})

		const farm = (name: string) => ({
			raw: `${name}, Raugi küla, Muhu vald`,
			components: { venue: name, dependent_locality: "Raugi küla", locality: "Muhu vald" },
			country: "RU",
		})

		const input = scratch.path("streetless.canonical.jsonl")
		const output = scratch.path("streetless.jsonl")

		await writeLocalJSONLFile(
			[...Array.from({ length: 10 }, (_, i) => premise(String(i + 1))), farm("Jüri"), farm("Põllu"), farm("Kase")],
			input
		)

		const report = await writeVarietySample({
			input,
			output,
			country: "RU",
			limits: { perStreet: 2, perPlace: 100, ceiling: 100, seed: 3 },
		})

		expect(report.sample.rows).toBe(5)
	})
})

describe("writeVarietySample", () => {
	it("writes the chosen lines verbatim and reports the variety of both sets", async () => {
		const row = (locality: string, street: string, number: string, unit?: string) => ({
			raw: `${street} ${number}${unit ? ` ${unit}` : ""}, ${locality}`,
			components: { street, house_number: number, locality, ...(unit ? { unit } : {}) },
			country: "RS",
			source: "osm-rs",
		})

		const rows = [
			...Array.from({ length: 20 }, (_, i) => row("Beograd", "Knez Mihailova", String(i + 1))),
			row("Beograd", "Bulevar kralja Aleksandra", "73", "5"),
			row("Novi Sad", "Zmaj Jovina", "4"),
			{ ...row("Niš", "Obrenovićeva", "1"), country: "BA" },
		]

		const input = scratch.path("osm-rs.canonical.jsonl")
		const output = scratch.path("osm-rs.jsonl")

		await writeLocalJSONLFile(rows, input)

		const report = await writeVarietySample({
			input,
			output,
			country: "RS",
			limits: { perStreet: 2, perPlace: 10, ceiling: 100, seed: 7 },
		})

		const written = await TextSpliterator.fromAsync(output)
			.filter((line) => line.length > 0)
			.toArray()

		expect(report.skipped).toEqual({ "country:BA": 1 })
		expect(report.full.rows).toBe(22)
		expect(report.sample.rows).toBe(4)
		expect(written).toHaveLength(4)
		expect(written.every((line) => rows.some((source) => stringifyJSON(source) === line))).toBe(true)
		expect(report.sample.localities).toBe(2)
		expect(report.coverage.localities).toBe(1)
		expect(report.sample.unitShare).toBe(0.25)

		const sidecar = await readLocalJSONFile<VarietySampleReport>(`${output.toString()}.variety.json`)

		expect(sidecar.outputSHA256).toBe(report.outputSHA256)
	})
})
