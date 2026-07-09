/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { type AnnotationSet, type Annotator, composeAnnotators, toNative, toOpenCage } from "./index.ts"

test("composeAnnotators: merges partial results from multiple annotators", async () => {
	const coords: Annotator = () => ({ geohash: "dqcjqcp84", mgrs: "18SUJ23480647" })
	const country: Annotator = () => ({ callingCode: 1, currency: { isoCode: "USD" } })
	const set = await composeAnnotators([coords, country])({ lat: 38.8977, lon: -77.0365 })

	expect(set.geohash).toBe("dqcjqcp84")
	expect(set.mgrs).toBe("18SUJ23480647")
	expect(set.callingCode).toBe(1)
	expect(set.currency).toEqual({ isoCode: "USD" })
})

test("composeAnnotators: a throwing annotator is skipped, the rest still apply", async () => {
	const ok: Annotator = () => ({ flag: "🇺🇸" })
	const boom: Annotator = () => {
		throw new Error("nope")
	}
	const set = await composeAnnotators([boom, ok])({ lat: 0, lon: 0 })

	expect(set.flag).toBe("🇺🇸")
})

test("composeAnnotators: later annotators win on key collision", async () => {
	const a: Annotator = () => ({ timezone: { name: "UTC" } })
	const b: Annotator = () => ({ timezone: { name: "America/New_York", offsetSec: -18000 } })
	const set = await composeAnnotators([a, b])({ lat: 0, lon: 0 })

	expect(set.timezone).toEqual({ name: "America/New_York", offsetSec: -18000 })
})

test("toOpenCage: maps native fields to OpenCage key names + casing", () => {
	const set: AnnotationSet = {
		dms: { lat: "38° 53′ 51″ N", lon: "77° 02′ 11″ W" },
		geohash: "dqcjqcp84",
		mercator: { x: -8575528, y: 4707174 },
		qiblaBearing: 58.4,
		callingCode: 1,
		currency: { isoCode: "USD", symbol: "$" },
		flag: "🇺🇸",
		timezone: { name: "America/New_York", offsetSec: -18000 },
		fips: "11001",
	}
	const oc = toOpenCage(set)

	expect(oc.DMS).toEqual({ lat: "38° 53′ 51″ N", lng: "77° 02′ 11″ W" }) // lon -> lng
	expect(oc.geohash).toBe("dqcjqcp84")
	expect(oc.Mercator).toEqual({ x: -8575528, y: 4707174 })
	expect(oc.qibla).toBe(58.4)
	expect(oc.callingcode).toBe(1)
	expect(oc.currency).toEqual({ iso_code: "USD", symbol: "$" }) // isoCode -> iso_code
	expect(oc.flag).toBe("🇺🇸")
	expect(oc.timezone).toEqual({ name: "America/New_York", offset_sec: -18000 }) // offsetSec -> offset_sec
	expect(oc.FIPS).toEqual({ county: "11001" })
})

test("toOpenCage: omits unpopulated fields", () => {
	expect(toOpenCage({})).toEqual({})
	expect(toOpenCage({ geohash: "x" })).toEqual({ geohash: "x" })
})

test("toNative: returns the native set unchanged", () => {
	const set: AnnotationSet = { geohash: "x", callingCode: 44 }
	expect(toNative(set)).toEqual(set)
})
