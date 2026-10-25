import { describe, expect, it } from "vitest"

import { stageBareAdminNames } from "#candidate/bare-admin-names"
import type { PlaceAttrs } from "#candidate/place-attrs"
import { normalizeLocalityForKey } from "#street/normalize"

const place = (name: string, cid: number, pop: number | null): PlaceAttrs => ({
	cid,
	rid: 0,
	ptid: 1,
	name,
	lat: 0,
	lon: 0,
	mnLat: 0,
	mnLon: 0,
	mxLat: 0,
	mxLon: 0,
	pop,
	neg: -Math.log10((pop ?? 0) + 1),
	pkey: normalizeLocalityForKey(name),
	imp: null,
})

describe("stageBareAdminNames", () => {
	it("keys a Japanese ward under its bare name, with the ward's own population, and leaves other countries alone", () => {
		const attrs = new Map<number, PlaceAttrs>([
			[1_108_739_697, place("渋谷区", 1, 243_000)],
			[1_108_739_698, place("港区", 1, 260_000)],
			[85_977_539, place("New York", 2, 8_336_000)],
		])

		const staged: Array<{ key: string; sid: number; pop: number | null; isPrimary: number }> = []

		const count = stageBareAdminNames({
			attrs,
			iso2ByID: new Map([
				[1, "JP"],
				[2, "US"],
			]),
			stageRow: (key, a, sid, isPrimary) => staged.push({ key, sid, pop: a.pop, isPrimary }),
			tx: { exec: () => {} },
		})

		expect(count).toBe(1)
		expect(staged).toEqual([{ key: normalizeLocalityForKey("渋谷"), sid: 1_108_739_697, pop: 243_000, isPrimary: 0 }])
	})
})
