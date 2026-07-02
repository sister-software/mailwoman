/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Schema-name derivation + shard routing tests.
 */

import { describe, expect, test } from "vitest"

import { deriveSchemaName, pickShardForPlacetype, resolveShards } from "./sharding.js"

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

describe("resolveShards", () => {
	test("single string → one shard named main", () => {
		expect(resolveShards("/tmp/whosonfirst-data-admin-us-latest.db")).toEqual([
			{ path: "/tmp/whosonfirst-data-admin-us-latest.db", schemaName: "main", placetypes: [] },
		])
	})

	test("array of strings: first becomes main, rest derive", () => {
		const r = resolveShards([
			"/tmp/whosonfirst-data-admin-us-latest.db",
			"/tmp/whosonfirst-data-postalcode-us-latest.db",
		])
		expect(r).toEqual([
			{ path: "/tmp/whosonfirst-data-admin-us-latest.db", schemaName: "main", placetypes: [] },
			{ path: "/tmp/whosonfirst-data-postalcode-us-latest.db", schemaName: "postalcode_us", placetypes: [] },
		])
	})

	test("ShardConfig.schemaName overrides derivation", () => {
		const r = resolveShards([
			"/tmp/whosonfirst-data-admin-us-latest.db",
			{ path: "/tmp/weird-name.db", schemaName: "postalcode_us" },
		])
		expect(r[1]?.schemaName).toBe("postalcode_us")
	})

	test("placetypes hint passes through", () => {
		const r = resolveShards([
			"/tmp/whosonfirst-data-admin-us-latest.db",
			{ path: "/tmp/whosonfirst-data-postalcode-us-latest.db", placetypes: ["postalcode"] },
		])
		expect(r[1]?.placetypes).toEqual(["postalcode"])
	})

	test("rejects shard name collisions on non-main shards", () => {
		// The first shard is always "main" regardless of its derived name; collisions only matter
		// across the non-first entries. Two postcode shards in a row collide.
		expect(() =>
			resolveShards([
				"/tmp/whosonfirst-data-admin-us-latest.db",
				"/tmp/whosonfirst-data-postalcode-us-latest.db",
				"/tmp/whosonfirst-data-postalcode-us-latest.db",
			])
		).toThrow(/collides/)
	})

	test("rejects schema names that aren't valid SQLite identifiers", () => {
		expect(() =>
			resolveShards([
				"/tmp/whosonfirst-data-admin-us-latest.db",
				{ path: "/tmp/weird.db", schemaName: "1nvalid-start" },
			])
		).toThrow(/not a valid SQLite identifier/)
	})

	test("non-main shard cannot use the reserved name `main`", () => {
		expect(() => resolveShards(["/tmp/a.db", { path: "/tmp/b.db", schemaName: "main" }])).toThrow(/collides/)
	})

	test("empty input rejects", () => {
		expect(() => resolveShards([])).toThrow(/at least one shard/)
	})
})

describe("pickShardForPlacetype", () => {
	const shards = resolveShards([
		"/tmp/whosonfirst-data-admin-us-latest.db",
		"/tmp/whosonfirst-data-postalcode-us-latest.db",
	])

	test("undefined placetype → main", () => {
		expect(pickShardForPlacetype(shards, undefined).schemaName).toBe("main")
	})

	test("postalcode → postalcode_us (substring match on schema name)", () => {
		expect(pickShardForPlacetype(shards, "postalcode").schemaName).toBe("postalcode_us")
	})

	test("locality → main (no postalcode-shard hit, falls back)", () => {
		expect(pickShardForPlacetype(shards, "locality").schemaName).toBe("main")
	})

	test("explicit placetypes hint wins over substring match", () => {
		const explicit = resolveShards([
			"/tmp/whosonfirst-data-admin-us-latest.db",
			{ path: "/tmp/whosonfirst-data-postalcode-us-latest.db", placetypes: ["postalcode", "region"] },
		])
		// `region` doesn't substring-match `postalcode_us`, but the explicit hint claims it.
		expect(pickShardForPlacetype(explicit, "region").schemaName).toBe("postalcode_us")
	})

	test("conservative substring match — does NOT false-positive on `region` matching `arboregion`", () => {
		const odd = resolveShards(["/tmp/whosonfirst-data-admin-us-latest.db", { path: "/tmp/arboregion.db" }])
		expect(pickShardForPlacetype(odd, "region").schemaName).toBe("main")
	})

	// #920 — country-aware routing across MULTIPLE placetype-matching shards: first-match starved
	// the second postcode shard (a FI postcode could never reach postalcode-geonames-tail behind
	// postalcode-us). With the query country + probed country sets, the claiming shard wins; the
	// original first-match order stays the tiebreak when no shard claims the country.
	test("country routes across two postcode shards (#920)", () => {
		const two = resolveShards([
			"/tmp/whosonfirst-data-admin-us-latest.db",
			"/tmp/whosonfirst-data-postalcode-us-latest.db",
			"/tmp/postalcode-geonames-tail.db",
		])
		const countries = new Map([
			["postalcode_us", new Set(["US"])],
			["postalcode_geonames_tail", new Set(["FI", "CZ", "PL"])],
		])

		expect(pickShardForPlacetype(two, "postalcode", { country: "FI", countriesBySchema: countries }).schemaName).toBe(
			"postalcode_geonames_tail"
		)
		expect(pickShardForPlacetype(two, "postalcode", { country: "US", countriesBySchema: countries }).schemaName).toBe(
			"postalcode_us"
		)
		// Unknown country / no probe → first placetype match (the pre-#920 behavior, unchanged).
		expect(pickShardForPlacetype(two, "postalcode", { country: "XX", countriesBySchema: countries }).schemaName).toBe(
			"postalcode_us"
		)
		expect(pickShardForPlacetype(two, "postalcode").schemaName).toBe("postalcode_us")
	})
})
