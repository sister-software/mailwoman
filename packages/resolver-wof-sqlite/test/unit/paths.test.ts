/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { DefaultMailwomanPaths } from "@mailwoman/core/env"
import { wofDatabasePath, wofDatabaseRoot, wofExtractPaths } from "@mailwoman/resolver-wof-sqlite/paths"
import { afterEach, expect, test, vi } from "vitest"

afterEach(() => {
	vi.unstubAllEnvs()
})

test("wofExtractPaths: builds the admin + postcode + tail + intl + NL-PC6 + NI-OSM database paths under a data root (#920/#977)", () => {
	// The 2026-09-15 regrouping moved every database artifact under `db/`,
	// and this test pinned the old prefix as six absolute string literals.
	// It therefore passed while `wofExtractPaths` named a directory holding no files.
	//
	// The layout is composed with the builder the rest of the tree uses,
	// so a future regrouping fails this assertion in one place.
	const wof = wofDatabaseRoot("/data")
	const extract = (name: string): string => wof(name).toString()

	expect(wofExtractPaths("/data")).toEqual([
		extract("admin-global-priority.db"),
		extract("postalcode-us.db"),
		extract("postalcode-geonames-tail.db"),
		extract("postalcode-intl.db"),
		extract("postalcode-nl-pc6.db"),
		// Build-local (ODbL): present only on the machine that built it, which is
		// exactly why it can be listed unconditionally.
		// Every caller filters with `existsSync`, and that filter is the tier.
		extract("postalcode-ni-osm.db"),
	])

	expect(extract("admin-global-priority.db")).toBe("/data/db/wof/admin-global-priority.db")
})

test("wofDatabasePath and wofExtractPaths read MAILWOMAN_DATA_ROOT when a path is requested", () => {
	vi.stubEnv("MAILWOMAN_DATA_ROOT", "/custom/root")
	expect(wofExtractPaths()[0]).toBe("/custom/root/db/wof/admin-global-priority.db")
	expect(wofDatabasePath("candidate.db").toString()).toBe("/custom/root/db/wof/candidate.db")

	vi.stubEnv("MAILWOMAN_DATA_ROOT", DefaultMailwomanPaths.data)
	expect(wofDatabasePath("candidate.db").toString()).toBe(`${DefaultMailwomanPaths.data}/db/wof/candidate.db`)
})
