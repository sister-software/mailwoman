/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Schema-name derivation + extract routing tests.
 */

import { deriveSchemaName, pickExtractForPlacetype, resolveExtracts } from "@mailwoman/resolver-wof-sqlite/extracts"
import { describe, expect, test } from "vitest"

describe("deriveSchemaName", () => {
	test("strips whosonfirst-data prefix and -latest.db suffix", () => {
		expect(deriveSchemaName("whosonfirst-data-admin-us-latest.db")).toBe("admin_us")
		expect(deriveSchemaName("whosonfirst-data-postalcode-us-latest.db")).toBe("postalcode_us")
		expect(deriveSchemaName("whosonfirst-data-admin-latest.db")).toBe("admin")
	})

	test("handles full paths (basename only)", () => {
		expect(deriveSchemaName("/mnt/playpen/mailwoman-data/wof/whosonfirst-data-admin-us-latest.db")).toBe("admin_us")
	})

	test("replaces non-identifier chars with underscores", () => {
		expect(deriveSchemaName("my-custom.db")).toBe("my_custom")
		expect(deriveSchemaName("places (2024).db")).toBe("places__2024_")
	})

	test("throws when the result is empty", () => {
		expect(() => deriveSchemaName(".db")).toThrow(/could not derive/)
		expect(() => deriveSchemaName("whosonfirst-data-.db")).toThrow(/could not derive/)
	})
})

describe("resolveExtracts", () => {
	test("single string → one extract named main", () => {
		expect(resolveExtracts("/tmp/whosonfirst-data-admin-us-latest.db")).toEqual([
			{ path: "/tmp/whosonfirst-data-admin-us-latest.db", schemaName: "main", placetypes: [] },
		])
	})

	test("array of strings: first becomes main, rest derive", () => {
		const r = resolveExtracts([
			"/tmp/whosonfirst-data-admin-us-latest.db",
			"/tmp/whosonfirst-data-postalcode-us-latest.db",
		])

		expect(r).toEqual([
			{ path: "/tmp/whosonfirst-data-admin-us-latest.db", schemaName: "main", placetypes: [] },
			{ path: "/tmp/whosonfirst-data-postalcode-us-latest.db", schemaName: "postalcode_us", placetypes: [] },
		])
	})

	test("ExtractConfig.schemaName overrides derivation", () => {
		const r = resolveExtracts([
			"/tmp/whosonfirst-data-admin-us-latest.db",
			{ path: "/tmp/weird-name.db", schemaName: "postalcode_us" },
		])

		expect(r[1]?.schemaName).toBe("postalcode_us")
	})

	test("placetypes hint passes through", () => {
		const r = resolveExtracts([
			"/tmp/whosonfirst-data-admin-us-latest.db",
			{ path: "/tmp/whosonfirst-data-postalcode-us-latest.db", placetypes: ["postalcode"] },
		])

		expect(r[1]?.placetypes).toEqual(["postalcode"])
	})

	test("rejects extract name collisions on non-main extracts", () => {
		// The first extract is always "main" regardless of its derived name; collisions only matter
		// across the non-first entries. Two postcode extracts in a row collide.
		expect(() =>
			resolveExtracts([
				"/tmp/whosonfirst-data-admin-us-latest.db",
				"/tmp/whosonfirst-data-postalcode-us-latest.db",
				"/tmp/whosonfirst-data-postalcode-us-latest.db",
			])
		).toThrow(/collides/)
	})

	test("rejects schema names that aren't valid SQLite identifiers", () => {
		expect(() =>
			resolveExtracts([
				"/tmp/whosonfirst-data-admin-us-latest.db",
				{ path: "/tmp/weird.db", schemaName: "1nvalid-start" },
			])
		).toThrow(/not a valid SQLite identifier/)
	})

	test("non-main extract cannot use the reserved name `main`", () => {
		expect(() => resolveExtracts(["/tmp/a.db", { path: "/tmp/b.db", schemaName: "main" }])).toThrow(/collides/)
	})

	test("empty input rejects", () => {
		expect(() => resolveExtracts([])).toThrow(/at least one extract/)
	})
})

describe("pickExtractForPlacetype", () => {
	const extracts = resolveExtracts([
		"/tmp/whosonfirst-data-admin-us-latest.db",
		"/tmp/whosonfirst-data-postalcode-us-latest.db",
	])

	test("undefined placetype → main", () => {
		expect(pickExtractForPlacetype(extracts, undefined).schemaName).toBe("main")
	})

	test("postalcode → postalcode_us (substring match on schema name)", () => {
		expect(pickExtractForPlacetype(extracts, "postalcode").schemaName).toBe("postalcode_us")
	})

	test("locality → main (no postalcode-extract hit, falls back)", () => {
		expect(pickExtractForPlacetype(extracts, "locality").schemaName).toBe("main")
	})

	test("explicit placetypes hint wins over substring match", () => {
		const explicit = resolveExtracts([
			"/tmp/whosonfirst-data-admin-us-latest.db",
			{ path: "/tmp/whosonfirst-data-postalcode-us-latest.db", placetypes: ["postalcode", "region"] },
		])

		// `region` doesn't substring-match `postalcode_us`, but the explicit hint claims it.
		expect(pickExtractForPlacetype(explicit, "region").schemaName).toBe("postalcode_us")
	})

	test("conservative substring match — does NOT false-positive on `region` matching `arboregion`", () => {
		const odd = resolveExtracts(["/tmp/whosonfirst-data-admin-us-latest.db", { path: "/tmp/arboregion.db" }])
		expect(pickExtractForPlacetype(odd, "region").schemaName).toBe("main")
	})

	// #920 — country-aware routing across MULTIPLE placetype-matching extracts: first-match starved
	// the second postcode extract (a FI postcode could never reach postalcode-geonames-tail behind
	// postalcode-us). With the query country + probed country sets, the claiming extract wins; the
	// original first-match order stays the tiebreak when no extract claims the country.
	test("country routes across two postcode extracts (#920)", () => {
		const two = resolveExtracts([
			"/tmp/whosonfirst-data-admin-us-latest.db",
			"/tmp/whosonfirst-data-postalcode-us-latest.db",
			"/tmp/postalcode-geonames-tail.db",
		])

		const countries = new Map([
			["postalcode_us", new Set(["US"])],
			["postalcode_geonames_tail", new Set(["FI", "CZ", "PL"])],
		])

		expect(pickExtractForPlacetype(two, "postalcode", { country: "FI", countriesBySchema: countries }).schemaName).toBe(
			"postalcode_geonames_tail"
		)

		expect(pickExtractForPlacetype(two, "postalcode", { country: "US", countriesBySchema: countries }).schemaName).toBe(
			"postalcode_us"
		)

		// Unknown country / no probe → first placetype match (the pre-#920 behavior, unchanged).
		expect(pickExtractForPlacetype(two, "postalcode", { country: "XX", countriesBySchema: countries }).schemaName).toBe(
			"postalcode_us"
		)

		expect(pickExtractForPlacetype(two, "postalcode").schemaName).toBe("postalcode_us")
	})
})
