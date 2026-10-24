/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalTextFile, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { TextSpliterator } from "spliterator"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
	type CountryHoldout,
	defaultHoldouts,
	HASHED_PLACE_HOLDOUT_DIVISOR,
	HASHED_PLACE_HOLDOUT_SHARE,
	hashBucket,
	hashedHoldoutPlace,
	hashedPlacesOverCap,
	hashSelectedPlace,
	heldOutRegionCap,
	HOLDOUT_CAP_MIN_ROWS,
	type HoldoutPolicy,
	splitForRow,
	splitRows,
	writeSplitManifests,
	writeSplitManifestsFromLabeledFiles,
} from "#utils/split"

interface MinRow {
	source_id: string
	country: string
	components: { region?: string; postcode?: string; locality?: string; street?: string; house_number?: string }
}

/**
 * A country's holdout as a policy object, with a bare array read as its region list.
 *
 * The same reading `splitForRow` makes, so these assertions hold whichever form `defaultHoldouts` returns.
 */
const policyOf = (holdout: CountryHoldout | undefined): HoldoutPolicy =>
	Array.isArray(holdout) ? { regions: holdout } : ((holdout ?? {}) as HoldoutPolicy)

const regionsOf = (holdout: CountryHoldout | undefined): readonly string[] => policyOf(holdout).regions ?? []

/**
 * The fields these assertions read off a written `SPLIT_MANIFEST.json`.
 */
interface SplitManifestOnDisk {
	corpus_version: string
	counts: Record<string, number>
	holdouts: Record<string, string[]>
}

const row = (id: string, country: string, region?: string): MinRow => ({
	source_id: id,
	country,
	components: region ? { region } : {},
})

let scratch: TemporaryDirectory

beforeEach(async () => {
	scratch = await temporaryDirectory("mailwoman-split-")
})

afterEach(async () => {
	await scratch[Symbol.asyncDispose]()
})

function splitTextIntoArray(text: string): string[] {
	return Array.from(TextSpliterator.from(text.trim()))
}

describe("hashBucket", () => {
	it("is deterministic", () => {
		expect(hashBucket("source-1", 2)).toBe(hashBucket("source-1", 2))
		expect(hashBucket("source-1", 10)).toBe(hashBucket("source-1", 10))
	})

	it("returns values in [0, n)", () => {
		for (let i = 0; i < 100; i++) {
			const b = hashBucket(`id-${i}`, 5)
			expect(b).toBeGreaterThanOrEqual(0)
			expect(b).toBeLessThan(5)
		}
	})

	it("distributes roughly evenly across buckets", () => {
		const counts = [0, 0, 0]

		for (let i = 0; i < 3000; i++) {
			counts[hashBucket(`id-${i}`, 3)]!++
		}

		for (const c of counts) {
			expect(c).toBeGreaterThan(800)
			expect(c).toBeLessThan(1200)
		}
	})
})

describe("splitForRow — hashed place holdout for an undeclared country", () => {
	it("keys a row by venue, then locality, then postcode prefix, then region", () => {
		expect(hashedHoldoutPlace({ venue: "Musée Gassi", locality: "Nairobi" })).toBe("venue:musée gassi")

		expect(hashedHoldoutPlace({ locality: " Nairobi ", postcode: "00100", region: "Nairobi" })).toBe("locality:nairobi")

		expect(hashedHoldoutPlace({ postcode: "00 100", region: "Nairobi" })).toBe("postcode:00")
		expect(hashedHoldoutPlace({ region: "Nairobi" })).toBe("region:nairobi")
		expect(hashedHoldoutPlace({})).toBeNull()
	})

	it("sends every row of one place to the same side of the train boundary", () => {
		const localities = Array.from({ length: 400 }, (_, index) => `Town ${index}`)

		const heldOut = localities.filter(
			(locality) => splitForRow({ source_id: `${locality}-a`, country: "KE", components: { locality } }) !== "train"
		)

		expect(heldOut.length).toBeGreaterThan(0)
		expect(heldOut.length).toBeLessThan(localities.length / 10)

		for (const locality of heldOut) {
			for (const suffix of ["b", "c", "d"]) {
				expect(splitForRow({ source_id: `${locality}-${suffix}`, country: "KE", components: { locality } })).not.toBe(
					"train"
				)
			}
		}

		expect(hashBucket(`KE|locality:${heldOut[0]!.toLowerCase()}`, HASHED_PLACE_HOLDOUT_DIVISOR)).toBe(0)
	})

	it("trains on a hash-selected place over the region cap and leaves smaller places held out", () => {
		const towns = Array.from({ length: 400 }, (_, index) => `Town ${index}`)
		const selected = towns.filter((locality) => hashSelectedPlace("KE", { locality }) !== null)

		expect(selected.length).toBeGreaterThan(2)

		const [large, ...small] = selected as [string, ...string[]]
		const cap = heldOutRegionCap(HASHED_PLACE_HOLDOUT_SHARE)
		const regionRows = 10_000

		const counts = [
			{
				country: "KE",
				place: `locality:${large.toLowerCase()}`,
				region: "nairobi",
				rows: Math.ceil(regionRows * cap) + 1,
			},
			...small.map((town) => ({ country: "KE", place: `locality:${town.toLowerCase()}`, region: "nairobi", rows: 10 })),
			// A place that is all of a region under the minimum is not checked.
			{ country: "KE", place: `locality:${small[0]!.toLowerCase()}`, region: "lamu", rows: HOLDOUT_CAP_MIN_ROWS - 1 },
		]

		const denominators = new Map([
			["KE|nairobi", regionRows],
			["KE|lamu", HOLDOUT_CAP_MIN_ROWS - 1],
		])

		const table = hashedPlacesOverCap(counts, denominators)

		expect(table).toEqual({ KE: [`locality:${large.toLowerCase()}`] })

		const split = (locality: string, trained: Record<string, readonly string[]>) =>
			splitForRow({ source_id: `${locality}-a`, country: "KE", components: { locality } }, defaultHoldouts(), trained)

		expect(split(large, table)).toBe("train")
		expect(split(large, {})).not.toBe("train")

		for (const town of towns.filter((t) => t !== large)) {
			expect(split(town, table)).toBe(split(town, {}))
		}
	})

	it("bounds a held-out place's share of its region by min(0.25, max(0.05, 3 × share))", () => {
		expect(heldOutRegionCap(0.001)).toBe(0.05)
		expect(heldOutRegionCap(0.02)).toBeCloseTo(0.06)
		expect(heldOutRegionCap(0.2)).toBe(0.25)
	})

	it("refuses a place whose region has no row count", () => {
		expect(() =>
			hashedPlacesOverCap([{ country: "KE", place: "locality:x", region: null, rows: 1 }], new Map())
		).toThrow(/no row count for KE\|/)
	})

	it("keeps a row with no place in train", () => {
		expect(splitForRow({ source_id: "x", country: "KE", components: { street: "Moi Avenue" } })).toBe("train")
	})

	it("leaves a declared country to its declared places", () => {
		expect(splitForRow({ source_id: "x", country: "US", components: { region: "Texas" } })).toBe("train")
	})
})

describe("splitRows — place holdout below the region", () => {
	it("holds out US rows in a declared ZIP area and trains on the rest of the same state (#2777)", () => {
		// 084 is Atlantic City in New Jersey. 077 and 085 are other New Jersey areas.
		const rows: MinRow[] = [
			{ ...row("us-1", "US", "NJ"), components: { region: "NJ", postcode: "08401" } },
			{ ...row("us-2", "US", "NJ"), components: { region: "NJ", postcode: "07701" } },
			{ ...row("us-3", "US", "NJ"), components: { region: "NJ", postcode: "08540" } },
		]

		const m = splitRows(rows)

		expect([...m.val, ...m.test]).toEqual(["us-1"])
		expect(m.train.toSorted()).toEqual(["us-2", "us-3"])
	})

	it("trains on a row of any region that carries no held-out place, including the regions held out before", () => {
		const rows: MinRow[] = ["Vermont", "VT", "Wyoming", "WY", "North Dakota", "ND", "Texas"].map((region, index) =>
			row(`us-${index}`, "US", region)
		)

		expect(splitRows(rows).train).toHaveLength(rows.length)
	})

	it("rows without a region land in train (no holdout match)", () => {
		const rows: MinRow[] = [row("us-1", "US")]
		const m = splitRows(rows)
		expect(m.train).toEqual(["us-1"])
	})

	it("custom holdouts override defaults", () => {
		const rows: MinRow[] = [row("us-1", "US", "Vermont"), row("us-2", "US", "California")]
		const m = splitRows(rows, { holdouts: { US: ["California"] } })
		expect(m.train).toEqual(["us-1"])
		expect([...m.val, ...m.test]).toEqual(["us-2"])
	})

	it("a held-out row's bucket is stable across reruns", () => {
		const holdouts = { US: ["Vermont", "Wyoming"] }
		const rows: MinRow[] = [row("us-1", "US", "Vermont"), row("us-2", "US", "Vermont"), row("us-3", "US", "Wyoming")]
		const m1 = splitRows(rows, { holdouts })
		const m2 = splitRows(rows, { holdouts })

		expect(m1.val.length + m1.test.length).toBe(3)

		expect(m1.val).toEqual(m2.val)
		expect(m1.test).toEqual(m2.test)
	})
})

describe("defaultHoldouts", () => {
	it("keys no country on a region, a closed-vocabulary label (#2777)", () => {
		// A region's name is a region span only in rows from that region, so a region key removes the label from training.
		for (const [country, holdout] of Object.entries(defaultHoldouts())) {
			expect(Array.isArray(holdout), country).toBe(false)
			expect(regionsOf(holdout), country).toEqual([])
		}
	})

	it("declares a holdout for every OSM country the decoder-exposure config admits, or leaves it to the hashed one", () => {
		// A country admitted to train with no holdout would have zero val and zero test rows.
		// CN and IN reach val and test through the hashed place holdout, because their
		// locality spans are too many and too small to list.
		expect(defaultHoldouts()["CN"]).toBeUndefined()
		expect(defaultHoldouts()["IN"]).toBeUndefined()

		const villages = Array.from({ length: 400 }, (_, index) => `Village ${index}`)

		for (const country of ["CN", "IN"]) {
			expect(
				villages.some(
					(locality) => splitForRow({ source_id: `${country}-1`, country, components: { locality } }) !== "train"
				),
				country
			).toBe(true)
		}

		for (const country of ["RU", "ID", "NG", "PK", "BD", "VN"]) {
			const policy = policyOf(defaultHoldouts()[country])

			expect(
				(policy.regions?.length ?? 0) + (policy.postcodePrefixes?.length ?? 0) + (policy.localities?.length ?? 0),
				country
			).toBeGreaterThan(0)
		}
	})

	it("declares a holdout for every French overseas jurisdiction with more than one commune, and for Romania", () => {
		// PM is left to the hashed holdout: neither of its two communes can be held out
		// without removing a name from training or taking most of its rows.
		expect(defaultHoldouts()["PM"]).toBeUndefined()

		for (const country of ["GP", "MQ", "GF", "RE", "YT", "PF", "NC", "RO"]) {
			const policy = policyOf(defaultHoldouts()[country])

			expect(
				(policy.regions?.length ?? 0) + (policy.postcodePrefixes?.length ?? 0) + (policy.localities?.length ?? 0),
				country
			).toBeGreaterThan(0)
		}
	})

	it("holds out a BAN overseas row by its commune postcode and a Romanian row by a postcode district", () => {
		const gp = { source_id: "ban-1", country: "GP", components: { street: "Rue Saint-Jean", postcode: "97128" } }
		const ro = { source_id: "ro-1", country: "RO", components: { street: "REPUBLICII", postcode: "700115" } }

		expect(splitForRow(gp)).not.toBe("train")
		expect(splitForRow({ ...gp, components: { street: "Rue Frébault", postcode: "97110" } })).toBe("train")
		expect(splitForRow(ro)).not.toBe("train")
		expect(splitForRow({ ...ro, components: { street: "UNIRII", postcode: "200000" } })).toBe("train")
	})

	it("holds out a case or spacing variant of a held-out locality", () => {
		const variants: [country: string, components: MinRow["components"]][] = [
			["VN", { locality: "Vũng Tàu" }],
			["VN", { locality: "PLEIKU" }],
			["IT", { locality: "Sant'Antioco" }],
			["NZ", { locality: " Dunedin " }],
		]

		for (const [country, components] of variants) {
			expect(
				splitForRow({ source_id: `${country}-v`, country, components }),
				`${country} ${components.region ?? components.locality}`
			).not.toBe("train")
		}

		expect(splitForRow({ source_id: "VN-v", country: "VN", components: { locality: "Vũng" } })).toBe("train")
	})

	it("holds out ES, IT, AU and NZ places inside a region, and trains on every row that names the region", () => {
		// A region key, or a postcode prefix that covers a whole region, removed `Illes Balears`,
		// `Principado de Asturias`, `Trento` and `TAS` from training as region labels (#2777).
		for (const region of ["Illes Balears", "Principado de Asturias", "Trento", "Bolzano/Bozen", "TAS", "NT"]) {
			for (const country of ["ES", "IT", "AU"]) {
				expect(splitForRow({ source_id: `${country}-r`, country, components: { region } }), region).toBe("train")
			}
		}

		const cases: [country: string, held: MinRow["components"], kept: MinRow["components"]][] = [
			[
				"ES",
				{ locality: "Adeje", region: "Santa Cruz de Tenerife" },
				{ locality: "La Laguna", region: "Santa Cruz de Tenerife" },
			],
			// The provinces held out whole before, by postcode 07 and 33, now train.
			["ES", { postcode: "38640", locality: "Arona" }, { postcode: "07001", locality: "Palma" }],
			["ES", { postcode: "38640", locality: "Arona" }, { postcode: "33003", locality: "Oviedo" }],
			["IT", { locality: "Cabras", region: "OR" }, { locality: "Oristano", region: "OR" }],
			["AU", { postcode: "7330", region: "TAS" }, { postcode: "7000", region: "TAS" }],
			["AU", { postcode: "0800", region: "NT" }, { postcode: "0810", region: "NT" }],
			["NZ", { locality: "Dunedin" }, { locality: "Invercargill" }],
		]

		for (const [country, held, kept] of cases) {
			expect(splitForRow({ source_id: `${country}-1`, country, components: held }), country).not.toBe("train")
			expect(splitForRow({ source_id: `${country}-1`, country, components: kept }), country).toBe("train")
		}
	})

	it("holds out an OSM street row by its city when it carries neither region nor postcode", () => {
		const nsukka = { source_id: "osm-1", country: "NG", components: { street: "Ogui Road", locality: "Nsukka" } }

		expect(splitForRow(nsukka)).not.toBe("train")
		expect(splitForRow({ ...nsukka, components: { street: "Ogui Road", locality: "Enugu" } })).toBe("train")
		expect(splitForRow({ ...nsukka, components: { street: "Allen Avenue", locality: "Ikeja" } })).toBe("train")
	})

	it("keeps the FR, DE and GB postcode areas, so held-out rows already verified unseen stay unseen", () => {
		// FR: Corse 20, Creuse 23, Lozère 48.
		// DE: Upper Lusatia 02.
		expect(policyOf(defaultHoldouts().FR).postcodePrefixes).toEqual(["20", "23", "48"])
		expect(policyOf(defaultHoldouts().DE).postcodePrefixes).toEqual(["02"])
	})

	it("names GB by postcode area, since a GB street row carries no region", () => {
		// GB had no entry before this change, so both splits held zero rows.
		// The number of rows this entry holds out remains unmeasured.
		// The lab data root contains no natural GB street rows.
		// The `split.ts` comment records the evidence used to set these prefixes.
		const gb = policyOf(defaultHoldouts().GB)

		expect(gb.postcodePrefixes?.slice(0, 2)).toEqual(["TR", "HX"])
		// The LL area is held out by district rather than whole (Conwy, Wrecsam and Sir Ddinbych lie inside it).
		expect(gb.postcodePrefixes).not.toContain("LL")

		expect(gb.postcodePrefixes?.filter((prefix) => prefix.startsWith("LL")).every((p) => /^LL\d{2}$/u.test(p))).toBe(
			true
		)

		expect(gb.regions).toBeUndefined()
	})

	it("gives every GB prefix at least two letters, so one area cannot swallow another", () => {
		// `L` is Liverpool and `LL` is Llandudno.
		// A one-letter prefix uses `startsWith`, so `L` would match Liverpool and Llandudno.
		// That would exceed the reviewed holdout size.
		const prefixes = policyOf(defaultHoldouts().GB).postcodePrefixes ?? []

		for (const prefix of prefixes) {
			expect(prefix).toMatch(/^[A-Z]{2}(\d{2})?$/u)
		}

		for (const prefix of prefixes) {
			expect(prefixes.filter((other) => other !== prefix && prefix.startsWith(other))).toEqual([])
		}
	})
})

describe("the holdout predicate reaches a row whose source emits no region (#2353)", () => {
	/**
	 * BAN street rows include a postcode and locality.
	 *
	 * They have no region.
	 * This shape covers 96.9% of FR training rows.
	 *
	 * A region-only predicate would exclude none of them even if its region list included every department.
	 */
	const banRow = (id: string, postcode: string): MinRow => ({
		source_id: id,
		country: "FR",
		components: { postcode, locality: "Ajaccio", street: "Cours Napoléon", house_number: "12" },
	})

	it("holds out a BAN row whose postcode names a held-out department", () => {
		expect(splitForRow(banRow("ban-corse", "20000"))).not.toBe("train")
		expect(splitForRow(banRow("ban-creuse", "23000"))).not.toBe("train")
		expect(splitForRow(banRow("ban-lozere", "48000"))).not.toBe("train")
	})

	it("trains on a BAN row from any other department", () => {
		expect(splitForRow(banRow("ban-paris", "75001"))).toBe("train")
		expect(splitForRow(banRow("ban-lyon", "69001"))).toBe("train")
		// 02 is Aisne.
		// A prefix match reads the first two digits, so a leading zero stays distinct from 20.
		expect(splitForRow(banRow("ban-aisne", "02000"))).toBe("train")
	})

	it("trains on a wof-admin row that names a held-out department as its region, with no postcode present", () => {
		expect(splitForRow(row("wof-corse", "FR", "Corse"))).toBe("train")
	})

	it("reads a bare array as a region list, which is what every manifest built before this carries", () => {
		expect(splitForRow(row("us-vt", "US", "Vermont"), { US: ["Vermont"] })).not.toBe("train")
		expect(splitForRow(row("us-or", "US", "Oregon"), { US: ["Vermont"] })).toBe("train")
	})

	it("holds out a GB street row by its postcode area, and trains on every other area", () => {
		// The same shape as BAN's, in GB's components: a street row with a postcode and no region.
		const gbRow = (id: string, postcode: string): MinRow => ({
			source_id: id,
			country: "GB",
			components: { postcode, locality: "Truro", street: "Lemon Street", house_number: "12" },
		})

		expect(splitForRow(gbRow("gb-truro", "TR1 2LS"))).not.toBe("train")
		expect(splitForRow(gbRow("gb-bangor", "LL57 2DG"))).not.toBe("train")
		// The LL area is held out by district, so Llandudno's LL30 trains.
		expect(splitForRow(gbRow("gb-llandudno", "LL30 2NB"))).toBe("train")
		expect(splitForRow(gbRow("gb-halifax", "HX1 1UG"))).not.toBe("train")

		expect(splitForRow(gbRow("gb-london", "SW1A 1AA"))).toBe("train")
		expect(splitForRow(gbRow("gb-manchester", "M1 1AE"))).toBe("train")
		// A one-letter `L` prefix would also match Liverpool and Llandudno.
		expect(splitForRow(gbRow("gb-liverpool", "L1 8JQ"))).toBe("train")
	})

	it("names DE by postcode area only", () => {
		// `synth-german` supplies every DE street row, and prefix `02` reaches them.
		// The Land names Saarland and Mecklenburg-Vorpommern are not keys (#2777).
		const de = policyOf(defaultHoldouts().DE)

		expect(de.regions).toBeUndefined()
		expect(de.postcodePrefixes).toEqual(["02"])
	})

	it("holds out a DE street row in postcode area 02 and trains on the rest of Sachsen", () => {
		// A `synth-german` row's shape: a street row carrying a postcode, with a region on some rows.
		const deRow = (id: string, postcode: string): MinRow => ({
			source_id: id,
			country: "DE",
			components: { postcode, locality: "Görlitz", street: "Berliner Straße", house_number: "14" },
		})

		// Görlitz, Bautzen and Zittau — Upper Lusatia, the declared area.
		expect(splitForRow(deRow("de-goerlitz", "02826"))).not.toBe("train")
		expect(splitForRow(deRow("de-bautzen", "02625"))).not.toBe("train")

		// Other Sachsen postcodes stay in train.
		// The corpus contains more than one row in this group.
		expect(splitForRow(deRow("de-dresden", "01067"))).toBe("train")
		expect(splitForRow(deRow("de-leipzig", "04103"))).toBe("train")
		expect(splitForRow(deRow("de-chemnitz", "09126"))).toBe("train")
		// Berlin, the other region `synth-german` emits.
		expect(splitForRow(deRow("de-berlin", "13469"))).toBe("train")
	})

	it("trains on a DE admin row of any Land, which carries no postcode", () => {
		// `wof-admin` is the only DE source carrying a region and it emits no postcode.
		const adminRow = (id: string, region: string): MinRow => ({
			source_id: id,
			country: "DE",
			components: { region, locality: "Saarbrücken" },
		})

		expect(splitForRow(adminRow("de-sl", "Saarland"))).toBe("train")
		expect(splitForRow(adminRow("de-mv", "Mecklenburg-Vorpommern"))).toBe("train")
		expect(splitForRow(adminRow("de-sn", "Sachsen"))).toBe("train")
	})

	it("holds out nothing for a country whose policy declares no matcher", () => {
		expect(splitForRow(banRow("ban-corse", "20000"), { FR: {} })).toBe("train")
	})

	it("matches a locality when one is declared", () => {
		expect(splitForRow(banRow("ban-ajaccio", "75001"), { FR: { localities: ["Ajaccio"] } })).not.toBe("train")
	})
})

describe("writeSplitManifests", () => {
	it("writes train/val/test txt files + SPLIT_MANIFEST.json", async () => {
		const m = splitRows(
			[
				{ ...row("us-1", "US", "NJ"), components: { region: "NJ", postcode: "08401" } },
				row("us-2", "US", "Oregon"),
				{ ...row("fr-1", "FR"), components: { postcode: "20000" } },
			],
			{ corpusVersion: "0.1.0" }
		)

		await writeSplitManifests(m, scratch.path)

		const train = await readLocalTextFile(scratch.path("train.txt"))

		const summary = await readLocalJSONFile<SplitManifestOnDisk>(scratch.path("SPLIT_MANIFEST.json"))
		expect(train.trim()).toBe("us-2")
		expect(summary.counts.total).toBe(3)
		expect(summary.corpus_version).toBe("0.1.0")
		expect(summary.holdouts.US).toEqual(defaultHoldouts().US)
	})

	it("manifests are sorted (diff-friendly) and reproducible", async () => {
		const rows: MinRow[] = [row("a", "US", "Oregon"), row("c", "US", "Oregon"), row("b", "US", "Oregon")]
		await writeSplitManifests(splitRows(rows), scratch.path)

		const first = await readLocalTextFile(scratch.path("train.txt"))

		await writeSplitManifests(splitRows(rows), scratch.path)

		const second = await readLocalTextFile(scratch.path("train.txt"))

		expect(first).toBe(second)
		expect(splitTextIntoArray(first)).toEqual(["a", "b", "c"])
	})
})

describe("splitForRow (pure per-row decision)", () => {
	it("matches splitRows for the same inputs", () => {
		const rows: MinRow[] = [
			row("us-1", "US", "Vermont"),
			row("us-2", "US", "Oregon"),
			row("us-3", "US", "Wyoming"),
			row("fr-1", "FR", "Corse"),
			row("fr-2", "FR", "Île-de-France"),
		]

		const manifest = splitRows(rows)

		for (const r of rows) {
			const split = splitForRow(r)

			if (split === "train") {
				expect(manifest.train).toContain(r.source_id)
			} else if (split === "val") {
				expect(manifest.val).toContain(r.source_id)
			} else {
				expect(manifest.test).toContain(r.source_id)
			}
		}
	})

	it("rows without a region land in train", () => {
		expect(splitForRow(row("us-1", "US"))).toBe("train")
	})

	it("custom holdouts override defaults", () => {
		expect(splitForRow(row("us-1", "US", "California"), { US: ["California"] })).not.toBe("train")
		expect(splitForRow(row("us-1", "US", "Vermont"), { US: ["California"] })).toBe("train")
	})
})

describe("writeSplitManifestsFromLabeledFiles (streaming)", () => {
	it("writes sorted train/val/test.txt + SPLIT_MANIFEST.json from per-split labeled JSONL", async () => {
		const labeledPaths = {
			train: scratch.path("labeled-train.jsonl"),
			val: scratch.path("labeled-val.jsonl"),
			test: scratch.path("labeled-test.jsonl"),
		}

		// Write per-split labeled files in non-sorted order to exercise the external sort.
		await writeLocalTextFile(
			['{"source_id":"us-c"}', '{"source_id":"us-a"}', '{"source_id":"us-b"}', ""].join("\n"),
			labeledPaths.train
		)

		await writeLocalTextFile(['{"source_id":"vt-2"}', '{"source_id":"vt-1"}', ""].join("\n"), labeledPaths.val)
		await writeLocalTextFile(['{"source_id":"wy-1"}', ""].join("\n"), labeledPaths.test)

		const counts = { train: 3, val: 2, test: 1 }

		const result = await writeSplitManifestsFromLabeledFiles({
			labeledPaths,
			outputDir: scratch.path,
			corpusVersion: "0.1.1",
			counts,
		})

		expect(result).toEqual({ train: 3, val: 2, test: 1, total: 6 })

		const train = await readLocalTextFile(scratch.path("train.txt"))

		expect(splitTextIntoArray(train)).toEqual(["us-a", "us-b", "us-c"])

		const val = await readLocalTextFile(scratch.path("val.txt"))

		expect(splitTextIntoArray(val)).toEqual(["vt-1", "vt-2"])

		const test = await readLocalTextFile(scratch.path("test.txt"))

		expect(test.trim()).toBe("wy-1")

		const summary = await readLocalJSONFile<SplitManifestOnDisk>(scratch.path("SPLIT_MANIFEST.json"))

		expect(summary).toMatchObject({
			corpus_version: "0.1.1",
			counts: { train: 3, val: 2, test: 1, total: 6 },
		})

		expect(summary.holdouts.US).toEqual(defaultHoldouts().US)
	})

	it("handles an empty per-split file (no source_ids → empty .txt)", async () => {
		const labeledPaths = {
			train: scratch.path("labeled-train.jsonl"),
			val: scratch.path("labeled-val.jsonl"),
			test: scratch.path("labeled-test.jsonl"),
		}

		await writeLocalTextFile('{"source_id":"only-train"}\n', labeledPaths.train)
		await writeLocalTextFile("", labeledPaths.val)
		await writeLocalTextFile("", labeledPaths.test)

		await writeSplitManifestsFromLabeledFiles({
			labeledPaths,
			outputDir: scratch.path,
			corpusVersion: "0.1.1",
			counts: { train: 1, val: 0, test: 0 },
		})

		expect((await readLocalTextFile(scratch.path("val.txt"))).trim()).toBe("")
		expect((await readLocalTextFile(scratch.path("test.txt"))).trim()).toBe("")
		expect((await readLocalTextFile(scratch.path("train.txt"))).trim()).toBe("only-train")
	})
})
