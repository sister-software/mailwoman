import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { describe, expect, it } from "vitest"

import {
	augmentExploredRow,
	exploreWOFRecord,
	findWOFFeaturePath,
	wofFeatureRelativePath,
} from "#adapters/wof/admin/json/explore"
import { useScratchDir } from "#test-kit"

const scratch = useScratchDir("wof-explore")

const COUNTRY = 85_633_793
const REGION = 85_688_543
const CITY = 85_977_539
const BOROUGH = 421_205_765

const feature = (id: number, placetype: string, name: string, parent: number, extra: Record<string, unknown> = {}) => ({
	type: "Feature",
	id,
	properties: {
		"wof:id": id,
		"wof:name": name,
		"wof:placetype": placetype,
		"wof:country": "US",
		"wof:parent_id": parent,
		"mz:is_current": 1,
		...extra,
	},
	geometry: null,
})

/**
 * Writes a Brooklyn-shaped tree under one `admin-us` repo.
 *
 * It holds the borough and its three ancestors.
 */
async function writeTree(...repoSegments: string[]): Promise<void> {
	const repo = scratch.path(...(repoSegments.length ? repoSegments : ["whosonfirst-data-admin-us"]))

	const files = [
		feature(COUNTRY, "country", "United States", -1, {
			"name:jpn_x_preferred": ["アメリカ合衆国"],
		}),
		feature(REGION, "region", "New York", COUNTRY, { "name:jpn_x_preferred": ["ニューヨーク州"] }),
		feature(CITY, "locality", "New York", REGION, { "name:jpn_x_preferred": ["ニューヨーク"] }),
		feature(BOROUGH, "borough", "Brooklyn", CITY, {
			"name:jpn_x_preferred": ["ブルックリン区"],
			"name:eng_x_colloquial": ["Kings"],
			"wof:hierarchy": [{ borough_id: BOROUGH, locality_id: CITY, region_id: REGION, country_id: COUNTRY }],
		}),
	]

	for (const file of files) {
		await writeLocalJSONFile(file, repo(wofFeatureRelativePath(file.id)))
	}
}

describe("wofFeatureRelativePath", () => {
	it("splits the id into groups of three digits from the left", () => {
		expect(wofFeatureRelativePath(421_205_765)).toBe("data/421/205/765/421205765.geojson")
		expect(wofFeatureRelativePath(85_977_539)).toBe("data/859/775/39/85977539.geojson")
	})
})

describe("exploreWOFRecord", () => {
	it("renders the rows of one record from only the files it names", async () => {
		await writeTree()

		const exploration = await exploreWOFRecord(BOROUGH, { reposRoot: scratch.path })

		expect(exploration.record.name).toBe("Brooklyn")
		expect(exploration.ancestors.map((ancestor) => ancestor.id).toSorted()).toEqual([COUNTRY, REGION, CITY].toSorted())
		expect(exploration.unresolvedAncestors).toEqual([])

		const keys = exploration.slots.map(({ slot }) => slot.key)

		expect(keys).toContain("default")
		expect(keys).toContain("name-jpn-x-preferred")
		expect(keys).toContain("name-eng-x-colloquial")

		const rows = exploration.slots.flatMap((slot) => slot.rows)

		expect(rows.length).toBeGreaterThan(0)

		for (const row of rows) {
			expect(row.source_id.startsWith(`wof-admin-${BOROUGH}-`)).toBe(true)
			expect(row.raw).not.toBe("")
		}

		const japanese = exploration.slots.find(({ slot }) => slot.key === "name-jpn-x-preferred")!

		expect(japanese.slot.language).toBe("jpn")
		expect(japanese.rows.some((row) => row.suffix !== "self")).toBe(true)
		expect(japanese.rows.every((row) => !Object.values(row.components).includes("New York"))).toBe(true)
	})

	it("reports an ancestor whose file is absent instead of dropping it silently", async () => {
		await writeTree()

		const missing = scratch.path("whosonfirst-data-admin-us")(wofFeatureRelativePath(REGION))
		const { removePath } = await import("@mailwoman/core/fs/writers")

		await removePath(missing)

		const exploration = await exploreWOFRecord(BOROUGH, { reposRoot: scratch.path })

		expect(exploration.unresolvedAncestors).toContain(REGION)
	})

	it("finds a repo one directory down, as the data root keeps whosonfirst-data", async () => {
		await writeTree("whosonfirst-data", "whosonfirst-data-admin-us")

		const exploration = await exploreWOFRecord(BOROUGH, { reposRoot: scratch.path })

		expect(exploration.path).toContain("whosonfirst-data/whosonfirst-data-admin-us")
		expect(exploration.ancestors).toHaveLength(3)
	})

	it("throws when no repo holds the record", async () => {
		await writeTree()

		expect(await findWOFFeaturePath(1, scratch.path)).toBeNull()
		await expect(exploreWOFRecord(1, { reposRoot: scratch.path })).rejects.toThrow(/no repo/)
	})
})

describe("augmentExploredRow", () => {
	it("keeps only augmentations that change the row", async () => {
		await writeTree()

		const exploration = await exploreWOFRecord(BOROUGH, { reposRoot: scratch.path })
		const row = exploration.slots.flatMap((slot) => slot.rows).find((candidate) => candidate.raw.includes(","))!

		const augmented = augmentExploredRow(row)

		expect(augmented.map((entry) => entry.augmentation)).toContain("drop-commas")
		expect(augmented.every((entry) => entry.raw !== row.raw)).toBe(true)
	})
})
