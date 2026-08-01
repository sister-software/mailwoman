/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `buildToolTable` against stub deps — no MCP transport/server involved. `server.ts`/`cli.ts`'s actual wiring isn't
 *   covered by a CI job (no stdio smoke run exists as of this writing) — `cli.ts` top-level-`await`s a real stdio
 *   connection, so it can't be imported here at all; its own type-checking (`tsc -b`) plus manual verification is
 *   what currently backs it, and its extractable pure logic (the decision-6 layer guards) has its own direct unit
 *   tests in `layer-guards.test.ts`. This file covers: every registered tool is present, each schema accepts a
 *   canonical example + rejects a bad one, and each handler routes to the correct dep with the correct arguments.
 */

import { describe, expect, it, vi } from "vitest"

import { buildToolTable, type MCPToolDeps } from "./tools.ts"

function stubDeps(): MCPToolDeps {
	return {
		parse: vi.fn(async () => ({ tag: "parsed" })),
		geocode: vi.fn(async () => ({ tag: "geocoded" })),
		poiSearch: vi.fn(async () => ({ tag: "poi-searched" })),
		overpassExport: vi.fn(async () => '[out:json][timeout:25];\nnwr["amenity"="cafe"];\nout center;'),
		layerManifest: vi.fn(async () => ({ tag: "manifest" })),
		// Mirrors the real `filingLandscape`'s own XOR throw (`bdc/sdk/filing-landscape.ts`) so the dispatch tests
		// below can exercise "the handler propagates a deps-level rejection" without reaching for a real bdc.db.
		bdcFilingLandscape: vi.fn(async (query: { geoids?: string[]; h3Cells?: number[] }) => {
			if (!query.geoids && !query.h3Cells) {
				throw new Error("bdcFilingLandscape: exactly one of `geoids` or `h3Cells` is required")
			}

			return { vintage: "2024-06", surveyed_block_count: 1, unknown_block_count: 0, filings: [] }
		}),
		// Mirrors the real `plausibilityCheck`'s (`bdc/sdk/plausibility.ts`) own graceful-abstain shape — decision 6
		// (2b task 7): an absent `bdcDatabasePath`/`poiDatabasePath` degrades to a typed abstain evidence entry in the
		// returned bundle, NEVER a throw, so the dispatch tests below can exercise "missing layer path → abstain-shaped
		// result, not a throw" against a stub without reaching for a real bdc.db/poi.db.
		plausibilityCheck: vi.fn(
			async (query: {
				bdcDatabasePath?: string
				poiDatabasePath?: string
				address?: string
				point?: { type: "Point"; coordinates: [number, number] }
				geoid?: string
				technologyCode: number
				claimedDownloadMbps: number
			}) => {
				const evidence_found: Array<Record<string, unknown>> = []

				if (!query.bdcDatabasePath) {
					evidence_found.push({ type: "abstain", reason: "requires_bdc_layer", layer: "bdc" })
				}

				if (!query.poiDatabasePath) {
					evidence_found.push({ type: "abstain", reason: "requires_build_local_layer", layer: "poi" })
				}

				return {
					claim: {
						address: query.address,
						point: query.point,
						geoid: query.geoid,
						technologyCode: query.technologyCode,
						claimedDownloadMbps: query.claimedDownloadMbps,
					},
					evidence_found,
					coverage_confidence: query.bdcDatabasePath && query.poiDatabasePath ? "high" : "insufficient_survey_data",
					coverage_detail: {
						filing: query.bdcDatabasePath ? "covered" : "layer_missing",
						physical: query.poiDatabasePath ? "covered" : "layer_missing",
					},
					block_resolution: query.geoid ? "geoid" : "h3_cell_approximation",
					vintage: query.bdcDatabasePath ? "2024-06" : null,
				}
			}
		),
		// Mirrors the real `filerLookup`'s (`@mailwoman/filer/sdk/filer-lookup.ts`) own XOR throw so the dispatch
		// tests below can exercise "the handler propagates a deps-level rejection" without reaching for a real filer.db.
		filerLookup: vi.fn(
			async (query: {
				databasePath: string
				frn?: string
				form499ID?: string
				bdcProviderID?: number
				asOf?: string
			}) => {
				const suppliedCount =
					(query.frn !== undefined ? 1 : 0) +
					(query.form499ID !== undefined ? 1 : 0) +
					(query.bdcProviderID !== undefined ? 1 : 0)

				if (suppliedCount !== 1) {
					throw new Error("filerLookup: exactly one of `frn`, `form499ID`, `bdcProviderID` is required")
				}

				return {
					node: { node_id: "frn:0001753557", identifier_type: "frn", identifier_value: "0001753557" },
					identifiers: [],
					attributes: {},
					cluster: null,
					inferred_links: [],
					as_of: query.asOf ?? "2026-07-31",
					vintage: "2026-Q1",
				}
			}
		),
		// Mirrors the real `familyRollup`'s (`@mailwoman/filer/sdk/family-rollup.ts`) own XOR throw AND its
		// always-array return shape (never `null`, never a bare object) so the dispatch tests below can exercise
		// both without reaching for a real filer.db.
		filerFamily: vi.fn(async (query: { databasePath: string; familyID?: string; nodeID?: string; asOf?: string }) => {
			const suppliedCount = (query.familyID !== undefined ? 1 : 0) + (query.nodeID !== undefined ? 1 : 0)

			if (suppliedCount !== 1) {
				throw new Error("familyRollup: exactly one of `familyID`, `nodeID` is required")
			}

			return [
				{
					family_id: query.familyID ?? "holding_company_name:acme-holdco",
					members: [
						{ node_id: "frn:0001753557", relationship: "holding_company", source: "form499" },
						{ node_id: "frn:0002222222", relationship: "holding_company", source: "form499" },
					],
					distinct_member_count: 2,
					display_names: ["Acme Holdco LLC"],
					as_of: query.asOf ?? "2026-07-31",
					vintage: "2026-Q1",
				},
			]
		}),
	}
}

function toolNamed(table: ReturnType<typeof buildToolTable>, name: string) {
	const tool = table.find((t) => t.name === name)

	if (!tool) throw new Error(`no tool named ${name}`)

	return tool
}

describe("buildToolTable", () => {
	it("registers exactly the nine expected tools", () => {
		const table = buildToolTable(stubDeps())

		expect(table.map((t) => t.name).toSorted()).toEqual(
			[
				"mailwoman_bdc_filing_landscape",
				"mailwoman_filer_family",
				"mailwoman_filer_lookup",
				"mailwoman_geocode",
				"mailwoman_layer_manifest",
				"mailwoman_overpass_export",
				"mailwoman_parse",
				"mailwoman_plausibility_check",
				"mailwoman_poi_search",
			].toSorted()
		)
	})

	it("every tool carries a non-empty description", () => {
		const table = buildToolTable(stubDeps())

		for (const tool of table) {
			expect(tool.description.length).toBeGreaterThan(20)
		}
	})

	describe("mailwoman_parse", () => {
		it("accepts a canonical example and rejects a missing text field", () => {
			const tool = toolNamed(buildToolTable(stubDeps()), "mailwoman_parse")

			expect(tool.inputSchema.safeParse({ text: "350 5th Ave, New York, NY 10118" }).success).toBe(true)
			expect(tool.inputSchema.safeParse({ text: "coffee near me", poi: true }).success).toBe(true)
			expect(tool.inputSchema.safeParse({}).success).toBe(false)
			expect(tool.inputSchema.safeParse({ text: "" }).success).toBe(false)
		})

		it("routes to deps.parse with the poi flag threaded through", async () => {
			const deps = stubDeps()
			const tool = toolNamed(buildToolTable(deps), "mailwoman_parse")

			await tool.handler({ text: "350 5th Ave", poi: true })
			expect(deps.parse).toHaveBeenCalledWith("350 5th Ave", { poi: true })
		})

		it("defaults poi to undefined when omitted", async () => {
			const deps = stubDeps()
			const tool = toolNamed(buildToolTable(deps), "mailwoman_parse")

			await tool.handler({ text: "350 5th Ave" })
			expect(deps.parse).toHaveBeenCalledWith("350 5th Ave", { poi: undefined })
		})
	})

	describe("mailwoman_geocode", () => {
		it("accepts a canonical example and rejects an empty string", () => {
			const tool = toolNamed(buildToolTable(stubDeps()), "mailwoman_geocode")

			expect(tool.inputSchema.safeParse({ text: "350 5th Ave, New York, NY 10118" }).success).toBe(true)
			expect(tool.inputSchema.safeParse({ text: "" }).success).toBe(false)
			expect(tool.inputSchema.safeParse({}).success).toBe(false)
		})

		it("routes to deps.geocode", async () => {
			const deps = stubDeps()
			const tool = toolNamed(buildToolTable(deps), "mailwoman_geocode")

			await tool.handler({ text: "350 5th Ave, New York, NY 10118" })
			expect(deps.geocode).toHaveBeenCalledWith("350 5th Ave, New York, NY 10118")
		})
	})

	describe("mailwoman_poi_search", () => {
		it("accepts a canonical example (with and without poiDatabasePath) and rejects a missing query", () => {
			const tool = toolNamed(buildToolTable(stubDeps()), "mailwoman_poi_search")

			expect(tool.inputSchema.safeParse({ query: "coffee near 350 5th Ave, New York" }).success).toBe(true)

			expect(
				tool.inputSchema.safeParse({ query: "coffee near 350 5th Ave, New York", poiDatabasePath: "/tmp/poi.db" })
					.success
			).toBe(true)

			expect(tool.inputSchema.safeParse({}).success).toBe(false)
			expect(tool.inputSchema.safeParse({ query: "" }).success).toBe(false)
		})

		it("routes to deps.poiSearch with the query + optional db path", async () => {
			const deps = stubDeps()
			const tool = toolNamed(buildToolTable(deps), "mailwoman_poi_search")

			await tool.handler({ query: "coffee near 350 5th Ave", poiDatabasePath: "/tmp/poi.db" })

			expect(deps.poiSearch).toHaveBeenCalledWith({
				query: "coffee near 350 5th Ave",
				poiDatabasePath: "/tmp/poi.db",
			})
		})
	})

	describe("mailwoman_overpass_export", () => {
		it("accepts a canonical example and rejects a missing query", () => {
			const tool = toolNamed(buildToolTable(stubDeps()), "mailwoman_overpass_export")

			expect(tool.inputSchema.safeParse({ query: "cafes in Paris" }).success).toBe(true)
			expect(tool.inputSchema.safeParse({}).success).toBe(false)
			expect(tool.inputSchema.safeParse({ query: "" }).success).toBe(false)
		})

		it("routes to deps.overpassExport and returns its raw string", async () => {
			const deps = stubDeps()
			const tool = toolNamed(buildToolTable(deps), "mailwoman_overpass_export")

			const result = await tool.handler({ query: "cafes in Paris" })
			expect(deps.overpassExport).toHaveBeenCalledWith("cafes in Paris")
			expect(result).toBe('[out:json][timeout:25];\nnwr["amenity"="cafe"];\nout center;')
		})
	})

	describe("mailwoman_layer_manifest", () => {
		it("accepts a canonical example and rejects a missing databasePath", () => {
			const tool = toolNamed(buildToolTable(stubDeps()), "mailwoman_layer_manifest")

			expect(tool.inputSchema.safeParse({ databasePath: "/data/poi.db" }).success).toBe(true)
			expect(tool.inputSchema.safeParse({}).success).toBe(false)
			expect(tool.inputSchema.safeParse({ databasePath: "" }).success).toBe(false)
		})

		it("routes to deps.layerManifest", async () => {
			const deps = stubDeps()
			const tool = toolNamed(buildToolTable(deps), "mailwoman_layer_manifest")

			await tool.handler({ databasePath: "/data/poi.db" })
			expect(deps.layerManifest).toHaveBeenCalledWith("/data/poi.db")
		})
	})

	describe("mailwoman_bdc_filing_landscape", () => {
		it("accepts a canonical geoids example and a canonical h3_cells example", () => {
			const tool = toolNamed(buildToolTable(stubDeps()), "mailwoman_bdc_filing_landscape")

			expect(tool.inputSchema.safeParse({ database_path: "/data/bdc.db", geoids: ["060750101001000"] }).success).toBe(
				true
			)

			expect(
				tool.inputSchema.safeParse({ database_path: "/data/bdc.db", h3_cells: [140_737_488_355_328] }).success
			).toBe(true)

			expect(tool.inputSchema.safeParse({ geoids: ["060750101001000"] }).success).toBe(false)
		})

		it("rejects an empty geoids array and an empty h3_cells array", () => {
			// `[]` passes a bare `.optional()` array schema (it's still a valid, present array) and would otherwise
			// reach `filingLandscape` as a query that answers with a vacuous all-zero landscape instead of erroring.
			const tool = toolNamed(buildToolTable(stubDeps()), "mailwoman_bdc_filing_landscape")

			expect(tool.inputSchema.safeParse({ database_path: "/data/bdc.db", geoids: [] }).success).toBe(false)
			expect(tool.inputSchema.safeParse({ database_path: "/data/bdc.db", h3_cells: [] }).success).toBe(false)
		})

		it("routes to deps.bdcFilingLandscape with the parsed database path and geoids", async () => {
			const deps = stubDeps()
			const tool = toolNamed(buildToolTable(deps), "mailwoman_bdc_filing_landscape")

			await tool.handler({ database_path: "/data/bdc.db", geoids: ["060750101001000"] })

			expect(deps.bdcFilingLandscape).toHaveBeenCalledWith({
				databasePath: "/data/bdc.db",
				geoids: ["060750101001000"],
				h3Cells: undefined,
			})
		})

		it("routes to deps.bdcFilingLandscape with the parsed database path and h3Cells", async () => {
			const deps = stubDeps()
			const tool = toolNamed(buildToolTable(deps), "mailwoman_bdc_filing_landscape")

			await tool.handler({ database_path: "/data/bdc.db", h3_cells: [140_737_488_355_328] })

			expect(deps.bdcFilingLandscape).toHaveBeenCalledWith({
				databasePath: "/data/bdc.db",
				geoids: undefined,
				h3Cells: [140_737_488_355_328],
			})
		})

		it("rejects at the handler level when both geoids and h3_cells are omitted", async () => {
			const tool = toolNamed(buildToolTable(stubDeps()), "mailwoman_bdc_filing_landscape")

			await expect(tool.handler({ database_path: "/data/bdc.db" })).rejects.toThrow(
				/exactly one of `geoids` or `h3Cells`/
			)
		})

		it("returns the deps result verbatim, vintage included", async () => {
			const tool = toolNamed(buildToolTable(stubDeps()), "mailwoman_bdc_filing_landscape")

			const result = await tool.handler({ database_path: "/data/bdc.db", geoids: ["060750101001000"] })

			expect(result).toEqual({
				vintage: "2024-06",
				surveyed_block_count: 1,
				unknown_block_count: 0,
				filings: [],
			})
		})
	})

	describe("mailwoman_plausibility_check", () => {
		it("accepts a canonical geoid claim, a point claim, and an address claim", () => {
			const tool = toolNamed(buildToolTable(stubDeps()), "mailwoman_plausibility_check")

			expect(
				tool.inputSchema.safeParse({
					geoid: "170010001001001",
					technology_code: 50,
					claimed_download_mbps: 100,
				}).success
			).toBe(true)

			expect(
				tool.inputSchema.safeParse({
					point: { type: "Point", coordinates: [-89.6501, 39.7817] },
					technology_code: 50,
					claimed_download_mbps: 100,
				}).success
			).toBe(true)

			expect(
				tool.inputSchema.safeParse({
					address: "350 5th Ave, New York, NY 10118",
					technology_code: 40,
					claimed_download_mbps: 25,
				}).success
			).toBe(true)
		})

		it("accepts optional bdc_database_path and poi_database_path", () => {
			const tool = toolNamed(buildToolTable(stubDeps()), "mailwoman_plausibility_check")

			expect(
				tool.inputSchema.safeParse({
					geoid: "170010001001001",
					technology_code: 50,
					claimed_download_mbps: 100,
					bdc_database_path: "/data/bdc.db",
					poi_database_path: "/data/poi.db",
				}).success
			).toBe(true)
		})

		it("rejects a claim missing technology_code or claimed_download_mbps", () => {
			const tool = toolNamed(buildToolTable(stubDeps()), "mailwoman_plausibility_check")

			expect(tool.inputSchema.safeParse({ geoid: "170010001001001", claimed_download_mbps: 100 }).success).toBe(false)
			expect(tool.inputSchema.safeParse({ geoid: "170010001001001", technology_code: 50 }).success).toBe(false)
			expect(tool.inputSchema.safeParse({}).success).toBe(false)
		})

		it("routes to deps.plausibilityCheck with snake_case fields mapped to the claim shape", async () => {
			const deps = stubDeps()
			const tool = toolNamed(buildToolTable(deps), "mailwoman_plausibility_check")

			await tool.handler({
				geoid: "170010001001001",
				technology_code: 50,
				claimed_download_mbps: 100,
				bdc_database_path: "/data/bdc.db",
				poi_database_path: "/data/poi.db",
			})

			expect(deps.plausibilityCheck).toHaveBeenCalledWith({
				bdcDatabasePath: "/data/bdc.db",
				poiDatabasePath: "/data/poi.db",
				address: undefined,
				point: undefined,
				geoid: "170010001001001",
				technologyCode: 50,
				claimedDownloadMbps: 100,
			})
		})

		it("missing bdc_database_path/poi_database_path → an abstain-shaped bundle, not a throw", async () => {
			const tool = toolNamed(buildToolTable(stubDeps()), "mailwoman_plausibility_check")

			const result = (await tool.handler({
				geoid: "170010001001001",
				technology_code: 50,
				claimed_download_mbps: 100,
			})) as { evidence_found: Array<{ type: string; reason?: string }>; vintage: string | null }

			expect(result.evidence_found).toEqual(
				expect.arrayContaining([
					{ type: "abstain", reason: "requires_bdc_layer", layer: "bdc" },
					{ type: "abstain", reason: "requires_build_local_layer", layer: "poi" },
				])
			)

			expect(result.vintage).toBeNull()
		})

		it("returns the deps result verbatim", async () => {
			const tool = toolNamed(buildToolTable(stubDeps()), "mailwoman_plausibility_check")

			const result = await tool.handler({
				geoid: "170010001001001",
				technology_code: 50,
				claimed_download_mbps: 100,
				bdc_database_path: "/data/bdc.db",
				poi_database_path: "/data/poi.db",
			})

			expect(result).toEqual({
				claim: {
					address: undefined,
					point: undefined,
					geoid: "170010001001001",
					technologyCode: 50,
					claimedDownloadMbps: 100,
				},
				evidence_found: [],
				coverage_confidence: "high",
				coverage_detail: { filing: "covered", physical: "covered" },
				block_resolution: "geoid",
				vintage: "2024-06",
			})
		})
	})

	describe("mailwoman_filer_lookup", () => {
		it("accepts a canonical example for each of frn, form499_id, and bdc_provider_id", () => {
			const tool = toolNamed(buildToolTable(stubDeps()), "mailwoman_filer_lookup")

			expect(tool.inputSchema.safeParse({ database_path: "/data/filer.db", frn: "0001753557" }).success).toBe(true)
			expect(tool.inputSchema.safeParse({ database_path: "/data/filer.db", form499_id: "899901" }).success).toBe(true)

			expect(tool.inputSchema.safeParse({ database_path: "/data/filer.db", bdc_provider_id: 130_077 }).success).toBe(
				true
			)
		})

		it("accepts an optional as_of and rejects a missing database_path", () => {
			const tool = toolNamed(buildToolTable(stubDeps()), "mailwoman_filer_lookup")

			expect(
				tool.inputSchema.safeParse({ database_path: "/data/filer.db", frn: "0001753557", as_of: "2026-06-01" }).success
			).toBe(true)

			expect(tool.inputSchema.safeParse({ frn: "0001753557" }).success).toBe(false)
			expect(tool.inputSchema.safeParse({ database_path: "" }).success).toBe(false)
		})

		it("routes to deps.filerLookup with the parsed database path and identifier fields", async () => {
			const deps = stubDeps()
			const tool = toolNamed(buildToolTable(deps), "mailwoman_filer_lookup")

			await tool.handler({ database_path: "/data/filer.db", form499_id: "899901", as_of: "2026-06-01" })

			expect(deps.filerLookup).toHaveBeenCalledWith({
				databasePath: "/data/filer.db",
				frn: undefined,
				form499ID: "899901",
				bdcProviderID: undefined,
				asOf: "2026-06-01",
			})
		})

		it("rejects at the handler level when no identifier is supplied", async () => {
			const tool = toolNamed(buildToolTable(stubDeps()), "mailwoman_filer_lookup")

			await expect(tool.handler({ database_path: "/data/filer.db" })).rejects.toThrow(
				/exactly one of `frn`, `form499ID`, `bdcProviderID`/
			)
		})

		it("rejects at the handler level when more than one identifier is supplied", async () => {
			const tool = toolNamed(buildToolTable(stubDeps()), "mailwoman_filer_lookup")

			await expect(
				tool.handler({ database_path: "/data/filer.db", frn: "0001753557", form499_id: "899901" })
			).rejects.toThrow(/exactly one of `frn`, `form499ID`, `bdcProviderID`/)
		})

		it("returns the deps result verbatim, as_of and vintage included", async () => {
			const tool = toolNamed(buildToolTable(stubDeps()), "mailwoman_filer_lookup")

			const result = await tool.handler({ database_path: "/data/filer.db", bdc_provider_id: 130_077 })

			expect(result).toEqual({
				node: { node_id: "frn:0001753557", identifier_type: "frn", identifier_value: "0001753557" },
				identifiers: [],
				attributes: {},
				cluster: null,
				inferred_links: [],
				as_of: "2026-07-31",
				vintage: "2026-Q1",
			})
		})
	})

	describe("mailwoman_filer_family", () => {
		it("accepts a canonical example for each of family_id and node_id", () => {
			const tool = toolNamed(buildToolTable(stubDeps()), "mailwoman_filer_family")

			expect(
				tool.inputSchema.safeParse({
					database_path: "/data/filer.db",
					family_id: "holding_company_name:acme-holdco",
				}).success
			).toBe(true)

			expect(tool.inputSchema.safeParse({ database_path: "/data/filer.db", node_id: "frn:0001753557" }).success).toBe(
				true
			)
		})

		it("accepts an optional as_of and rejects a missing database_path", () => {
			const tool = toolNamed(buildToolTable(stubDeps()), "mailwoman_filer_family")

			expect(
				tool.inputSchema.safeParse({
					database_path: "/data/filer.db",
					node_id: "frn:0001753557",
					as_of: "2026-06-01",
				}).success
			).toBe(true)

			expect(tool.inputSchema.safeParse({ node_id: "frn:0001753557" }).success).toBe(false)
			expect(tool.inputSchema.safeParse({ database_path: "" }).success).toBe(false)
		})

		it("routes to deps.filerFamily with the parsed database path and identifier fields", async () => {
			const deps = stubDeps()
			const tool = toolNamed(buildToolTable(deps), "mailwoman_filer_family")

			await tool.handler({ database_path: "/data/filer.db", node_id: "frn:0001753557", as_of: "2026-06-01" })

			expect(deps.filerFamily).toHaveBeenCalledWith({
				databasePath: "/data/filer.db",
				familyID: undefined,
				nodeID: "frn:0001753557",
				asOf: "2026-06-01",
			})
		})

		it("rejects at the handler level when no identifier is supplied", async () => {
			const tool = toolNamed(buildToolTable(stubDeps()), "mailwoman_filer_family")

			await expect(tool.handler({ database_path: "/data/filer.db" })).rejects.toThrow(
				/exactly one of `familyID`, `nodeID`/
			)
		})

		it("rejects at the handler level when both identifiers are supplied", async () => {
			const tool = toolNamed(buildToolTable(stubDeps()), "mailwoman_filer_family")

			await expect(
				tool.handler({
					database_path: "/data/filer.db",
					family_id: "holding_company_name:acme-holdco",
					node_id: "frn:0001753557",
				})
			).rejects.toThrow(/exactly one of `familyID`, `nodeID`/)
		})

		it("returns the deps result verbatim — every FamilyRollup field intact, nothing dropped or reshaped", async () => {
			const tool = toolNamed(buildToolTable(stubDeps()), "mailwoman_filer_family")

			const result = await tool.handler({
				database_path: "/data/filer.db",
				family_id: "holding_company_name:acme-holdco",
			})

			expect(result).toEqual([
				{
					family_id: "holding_company_name:acme-holdco",
					members: [
						{ node_id: "frn:0001753557", relationship: "holding_company", source: "form499" },
						{ node_id: "frn:0002222222", relationship: "holding_company", source: "form499" },
					],
					distinct_member_count: 2,
					display_names: ["Acme Holdco LLC"],
					as_of: "2026-07-31",
					vintage: "2026-Q1",
				},
			])
		})
	})
})
