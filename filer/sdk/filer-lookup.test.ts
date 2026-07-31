/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The four pre-registered 3a acceptance gates (`describe("§7-3a gates")` below — see
 *   `docs/superpowers/plans/2026-07-31-filer-3a-plan.md`'s "Acceptance gates (§7-3a…)" section for the
 *   gates verbatim, and `task-7-brief.md` for the per-gate implementation notes), plus {@linkcode filerLookup}'s
 *   general reader-contract tests and {@linkcode pickPrimaryFRN}'s direct unit tests.
 *
 *   Fixtures are built directly against an in-memory `filer.db` (nodes/edges/attributes/cluster rows inserted
 *   straight through Kysely) — the same convention `schema.test.ts` and `cluster-filers.test.ts` use — EXCEPT
 *   for gate 1's builder-guard sub-tests, which go through {@linkcode buildFilerDatabase} on purpose (the
 *   guards under test live there, not in the schema).
 *
 *   Gate 2 in particular is a fixture built by hand (filer_cluster rows written directly, never via
 *   `cluster-filers.ts`'s `clusterAuthoritativeComponents`/`clusterInferredLinks`) — per the task brief, this
 *   suite asserts {@linkcode filerLookup}'s OWN reading contract (does it keep `cluster` and `inferred_links`
 *   apart?), not clustering internals, which `cluster-filers.test.ts` already gates.
 */

import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import type { Insertable } from "kysely"
import { describe, expect, it } from "vitest"

import {
	createFilerAttributeTable,
	createFilerClusterTable,
	createFilerEdgeTable,
	createFilerManifestTable,
	createFilerNodeTable,
	FilerEdgeAssertion,
	FilerIdentifierType,
	type FilerDatabase,
	type FilerEdgeTable,
	type FilerManifestTable,
} from "../schema.ts"
import { buildFilerDatabase } from "./build-filer.ts"
import { filerLookup, pickPrimaryFRN, type FRNFilingRecord } from "./filer-lookup.ts"
import type { Form499Row } from "./form499.ts"
import { toFRN } from "./frn.ts"
import type { ProviderListRow } from "./provider-list.ts"

function openMemory(): DatabaseClient<FilerDatabase> {
	return new DatabaseClient<FilerDatabase>({ database: new DatabaseSync(":memory:") })
}

async function createAllTables(db: DatabaseClient<FilerDatabase>): Promise<void> {
	await createFilerNodeTable(db)
	await createFilerEdgeTable(db)
	await createFilerAttributeTable(db)
	await createFilerClusterTable(db)
	await createFilerManifestTable(db)
}

const MANIFEST: FilerManifestTable = {
	name: "filer",
	version: "2026-Q1",
	schema_version: 1,
	source: "form-499,bdc-provider-list",
	source_vintage: "2026-Q1",
	build_cmd: "mailwoman filer build",
	build_sha: "deadbeef",
	created_at: "2026-01-01T00:00:00Z",
}

async function seedManifest(db: DatabaseClient<FilerDatabase>): Promise<void> {
	await db.insertInto("filer_manifest").values(MANIFEST).execute()
}

function authoritativeEdge(
	overrides: Pick<FilerEdgeTable, "from_node_id" | "to_node_id" | "source" | "source_vintage" | "valid_from"> &
		Partial<FilerEdgeTable>
): FilerEdgeTable {
	return {
		assertion: FilerEdgeAssertion.Authoritative,
		valid_to: null,
		match_score: null,
		evidence: null,
		...overrides,
	}
}

let scratch: string | undefined

async function withScratchDir<T>(fn: (out: string) => Promise<T>): Promise<T> {
	scratch = await mkdtemp(join(tmpdir(), "filer-lookup-gate1-"))
	const out = join(scratch, "filer.db")

	try {
		return await fn(out)
	} finally {
		await rm(scratch, { recursive: true, force: true })
		scratch = undefined
	}
}

function minimalForm499Row(overrides: Partial<Form499Row> = {}): Form499Row {
	return {
		form499ID: "899901",
		frn: toFRN("0001753557"),
		lastFiledAt: "2026-01-15",
		usfContributor: false,
		legalNameOfCarrier: "Gate Co",
		doingBusinessAs: "",
		principalCommType: "",
		holdingCompany: "",
		managementCompany: "",
		hqAddress: "",
		customerInquiriesTelephone: "",
		customerInquiriesAddress: "",
		dcAgentDisplayName: "",
		dcAgentOrganizationName: "",
		dcAgentTelephone: "",
		dcAgentEmailAddress: "",
		dcAgentAddress: "",
		...overrides,
	}
}

describe("§7-3a gates", () => {
	describe("1. Provenance completeness (load-bearing)", () => {
		/**
		 * STRUCTURAL half of the gate (the established idiom — see `bdc/sdk/plausibility.test.ts`): an exhaustive
		 * `satisfies Record<keyof FilerEdgeInsert, true>` pin over `filer_edge`'s insert shape. `FilerEdgeTable` carries no
		 * `Generated<>`-wrapped columns (`schema.ts`'s own docstring), so Kysely's `Insertable<FilerEdgeTable>` already
		 * requires every field on insert — this pin's job is making sure that guarantee can't silently erode: a field ADDED
		 * to `FilerEdgeTable` that this literal doesn't also list fails `satisfies` (excess-property / missing-property
		 * checking on an object literal assigned via `satisfies`), forcing a reviewer to touch this file and consciously
		 * answer "is the new field also load-bearing provenance?" Only `tsc` (`yarn typecheck:tests`) checks the
		 * `satisfies` clause itself — `yarn vitest run` alone (esbuild, types stripped) only runs the `it()` below.
		 */
		type FilerEdgeInsert = Insertable<FilerEdgeTable>

		const FILER_EDGE_INSERT_FIELDS = {
			from_node_id: true,
			to_node_id: true,
			assertion: true,
			source: true,
			source_vintage: true,
			valid_from: true,
			valid_to: true,
			match_score: true,
			evidence: true,
		} satisfies Record<keyof FilerEdgeInsert, true>

		it("the structural pin enumerates every FilerEdgeTable field, including all four load-bearing ones", () => {
			expect(Object.keys(FILER_EDGE_INSERT_FIELDS)).toHaveLength(9)

			expect(FILER_EDGE_INSERT_FIELDS).toMatchObject({
				source: true,
				source_vintage: true,
				assertion: true,
				valid_from: true,
			})
		})

		it("runtime: a filer_edge insert missing valid_from is rejected", async () => {
			using db = openMemory()
			await createAllTables(db)

			await db
				.insertInto("filer_node")
				.values([
					{ node_id: "frn:1111111111", identifier_type: FilerIdentifierType.FRN, identifier_value: "1111111111" },
					{ node_id: "form499_id:100", identifier_type: FilerIdentifierType.Form499ID, identifier_value: "100" },
				])
				.execute()

			const partialEdge = {
				from_node_id: "frn:1111111111",
				to_node_id: "form499_id:100",
				assertion: FilerEdgeAssertion.Authoritative,
				source: "form-499",
				source_vintage: "2026-01-15",
				// valid_from deliberately omitted — this is the runtime half of gate 1's rejection test.
				valid_to: null,
				match_score: null,
				evidence: null,
			} as unknown as FilerEdgeInsert

			await expect(db.insertInto("filer_edge").values(partialEdge).execute()).rejects.toThrow(
				/NOT NULL constraint failed/
			)
		})

		it("runtime: a filer_edge insert missing source is rejected", async () => {
			using db = openMemory()
			await createAllTables(db)

			await db
				.insertInto("filer_node")
				.values([
					{ node_id: "frn:2222222222", identifier_type: FilerIdentifierType.FRN, identifier_value: "2222222222" },
					{ node_id: "form499_id:200", identifier_type: FilerIdentifierType.Form499ID, identifier_value: "200" },
				])
				.execute()

			const partialEdge = {
				from_node_id: "frn:2222222222",
				to_node_id: "form499_id:200",
				assertion: FilerEdgeAssertion.Authoritative,
				// source deliberately omitted
				source_vintage: "2026-01-15",
				valid_from: "2026-01-15",
				valid_to: null,
				match_score: null,
				evidence: null,
			} as unknown as FilerEdgeInsert

			await expect(db.insertInto("filer_edge").values(partialEdge).execute()).rejects.toThrow(
				/NOT NULL constraint failed/
			)
		})

		it("SQLite's NOT NULL alone does NOT reject an empty-string valid_from — this is why the builder-level guards below are load-bearing (Task 5 note)", async () => {
			using db = openMemory()
			await createAllTables(db)

			await db
				.insertInto("filer_node")
				.values([
					{ node_id: "frn:3333333333", identifier_type: FilerIdentifierType.FRN, identifier_value: "3333333333" },
					{ node_id: "form499_id:300", identifier_type: FilerIdentifierType.Form499ID, identifier_value: "300" },
				])
				.execute()

			await expect(
				db
					.insertInto("filer_edge")
					.values(
						authoritativeEdge({
							from_node_id: "frn:3333333333",
							to_node_id: "form499_id:300",
							source: "form-499",
							source_vintage: "",
							valid_from: "",
						})
					)
					.execute()
			).resolves.not.toThrow()
		})

		it("guards reject a whitespace-only lastFiledAt (not just empty) via buildFilerDatabase", async () => {
			await withScratchDir(async (out) => {
				await expect(
					buildFilerDatabase({
						form499Rows: [minimalForm499Row({ lastFiledAt: "   " })],
						out,
						sourceVintage: "2026-Q1",
						buildSHA: "deadbeef",
					})
				).rejects.toThrow(/malformed.*lastFiledAt/i)

				expect(existsSync(out)).toBe(false)
			})
		})

		it("guards reject an empty lastFiledAt via buildFilerDatabase", async () => {
			await withScratchDir(async (out) => {
				await expect(
					buildFilerDatabase({
						form499Rows: [minimalForm499Row({ lastFiledAt: "" })],
						out,
						sourceVintage: "2026-Q1",
						buildSHA: "deadbeef",
					})
				).rejects.toThrow(/malformed.*lastFiledAt/i)

				expect(existsSync(out)).toBe(false)
			})
		})

		it("guards reject a whitespace-only form499ID (not just empty) via buildFilerDatabase", async () => {
			await withScratchDir(async (out) => {
				await expect(
					buildFilerDatabase({
						form499Rows: [minimalForm499Row({ form499ID: "   " })],
						out,
						sourceVintage: "2026-Q1",
						buildSHA: "deadbeef",
					})
				).rejects.toThrow(/malformed.*empty form499ID/i)

				expect(existsSync(out)).toBe(false)
			})
		})

		it("guards reject a whitespace-only provider-list frn (not just empty) via buildFilerDatabase", async () => {
			await withScratchDir(async (out) => {
				const malformedRows: ProviderListRow[] = [
					{ providerID: 900_010, frn: "   " as ProviderListRow["frn"], holdingCompany: null },
				]

				await expect(
					buildFilerDatabase({
						providerRows: malformedRows,
						out,
						sourceVintage: "2026-Q1",
						buildSHA: "deadbeef",
					})
				).rejects.toThrow(/malformed.*empty frn/i)

				expect(existsSync(out)).toBe(false)
			})
		})
	})

	describe("2. Authoritative/inferred never conflated", () => {
		it("filerLookup surfaces ONLY the authoritative cluster in `cluster`, and reports an inferred link that WOULD bridge two authoritative components separately in `inferred_links` — never merged (decision 5)", async () => {
			using db = openMemory()
			await createAllTables(db)
			await seedManifest(db)

			const FRN_A = `${FilerIdentifierType.FRN}:1000000001`
			const FORM_A = `${FilerIdentifierType.Form499ID}:1000`
			const FRN_B = `${FilerIdentifierType.FRN}:2000000002`
			const FORM_B = `${FilerIdentifierType.Form499ID}:2000`

			await db
				.insertInto("filer_node")
				.values([
					{ node_id: FRN_A, identifier_type: FilerIdentifierType.FRN, identifier_value: "1000000001" },
					{ node_id: FORM_A, identifier_type: FilerIdentifierType.Form499ID, identifier_value: "1000" },
					{ node_id: FRN_B, identifier_type: FilerIdentifierType.FRN, identifier_value: "2000000002" },
					{ node_id: FORM_B, identifier_type: FilerIdentifierType.Form499ID, identifier_value: "2000" },
				])
				.execute()

			await db
				.insertInto("filer_edge")
				.values([
					authoritativeEdge({
						from_node_id: FRN_A,
						to_node_id: FORM_A,
						source: "form-499",
						source_vintage: "2026-01-01",
						valid_from: "2026-01-01",
					}),
					authoritativeEdge({
						from_node_id: FRN_B,
						to_node_id: FORM_B,
						source: "form-499",
						source_vintage: "2026-01-01",
						valid_from: "2026-01-01",
					}),
				])
				.execute()

			// The would-be bridge: an INFERRED edge directly connecting the two otherwise-separate authoritative
			// components — exactly the shape gate 2 exists to keep out of `cluster`.
			await db
				.insertInto("filer_edge")
				.values({
					from_node_id: FORM_A,
					to_node_id: FORM_B,
					assertion: FilerEdgeAssertion.Inferred,
					source: "cluster-filers",
					source_vintage: "2026-cluster-v1",
					valid_from: "2026-01-01",
					valid_to: null,
					match_score: -5,
					evidence: JSON.stringify({ memberNodeIds: [FORM_A, FORM_B] }),
				})
				.execute()

			// Fixture-built directly — exactly as Task 6's clusterAuthoritativeComponents WOULD leave it, two
			// SEPARATE authoritative clusters — never via cluster-filers.ts itself, so this test asserts
			// filerLookup's OWN reading contract, not clustering internals (already gated by cluster-filers.test.ts).
			await db
				.insertInto("filer_cluster")
				.values([
					{ node_id: FRN_A, cluster_id: "authoritative:A", assertion: FilerEdgeAssertion.Authoritative },
					{ node_id: FORM_A, cluster_id: "authoritative:A", assertion: FilerEdgeAssertion.Authoritative },
					{ node_id: FRN_B, cluster_id: "authoritative:B", assertion: FilerEdgeAssertion.Authoritative },
					{ node_id: FORM_B, cluster_id: "authoritative:B", assertion: FilerEdgeAssertion.Authoritative },
				])
				.execute()

			const resultA = await filerLookup(db, { form499ID: "1000", asOf: "2026-06-01" })

			expect(resultA.cluster).toEqual({ cluster_id: "authoritative:A", members: [FRN_A, FORM_A].toSorted() })
			// GATE 2: the inferred edge that WOULD bridge A and B is reported separately, never inside `cluster`.
			expect(resultA.inferred_links).toEqual([{ to: FORM_B, score: -5, source: "cluster-filers" }])

			const resultB = await filerLookup(db, { form499ID: "2000", asOf: "2026-06-01" })

			expect(resultB.cluster).toEqual({ cluster_id: "authoritative:B", members: [FRN_B, FORM_B].toSorted() })
			expect(resultB.inferred_links).toEqual([{ to: FORM_A, score: -5, source: "cluster-filers" }])
		})
	})

	describe("3. Cardinality fidelity", () => {
		const PROVIDER_NODE = `${FilerIdentifierType.BDCProviderID}:500001`
		const FRN_EARLY = `${FilerIdentifierType.FRN}:0001111111`
		const FRN_LATE = `${FilerIdentifierType.FRN}:0002222222`
		const FORM_EARLY = `${FilerIdentifierType.Form499ID}:9001`
		const FORM_LATE = `${FilerIdentifierType.Form499ID}:9002`

		async function seedTwoFRNProvider(db: DatabaseClient<FilerDatabase>): Promise<void> {
			await createAllTables(db)
			await seedManifest(db)

			await db
				.insertInto("filer_node")
				.values([
					{ node_id: PROVIDER_NODE, identifier_type: FilerIdentifierType.BDCProviderID, identifier_value: "500001" },
					{ node_id: FRN_EARLY, identifier_type: FilerIdentifierType.FRN, identifier_value: "0001111111" },
					{ node_id: FRN_LATE, identifier_type: FilerIdentifierType.FRN, identifier_value: "0002222222" },
					{ node_id: FORM_EARLY, identifier_type: FilerIdentifierType.Form499ID, identifier_value: "9001" },
					{ node_id: FORM_LATE, identifier_type: FilerIdentifierType.Form499ID, identifier_value: "9002" },
				])
				.execute()

			await db
				.insertInto("filer_edge")
				.values([
					// The provider_id carries TWO FRN edges — decision 6's cardinality.
					authoritativeEdge({
						from_node_id: PROVIDER_NODE,
						to_node_id: FRN_EARLY,
						source: "bdc-provider-list",
						source_vintage: "2026-Q2",
						valid_from: "2026-06-30",
					}),
					authoritativeEdge({
						from_node_id: PROVIDER_NODE,
						to_node_id: FRN_LATE,
						source: "bdc-provider-list",
						source_vintage: "2026-Q2",
						valid_from: "2026-06-30",
					}),
					// Each FRN's own most recent form-499 filing — FRN_LATE's is the LATER filing date.
					authoritativeEdge({
						from_node_id: FRN_EARLY,
						to_node_id: FORM_EARLY,
						source: "form-499",
						source_vintage: "2026-01-15",
						valid_from: "2026-01-15",
					}),
					authoritativeEdge({
						from_node_id: FRN_LATE,
						to_node_id: FORM_LATE,
						source: "form-499",
						source_vintage: "2026-05-20",
						valid_from: "2026-05-20",
					}),
				])
				.execute()
		}

		it("a provider_id carrying two FRNs round-trips BOTH edges through filerLookup — never collapsed", async () => {
			using db = openMemory()
			await seedTwoFRNProvider(db)

			const result = await filerLookup(db, { bdcProviderID: 500_001, asOf: "2026-12-31" })

			const frnValues = result.identifiers
				.filter((identifier) => identifier.type === FilerIdentifierType.FRN)
				.map((identifier) => identifier.value)
				.toSorted()

			expect(frnValues).toEqual(["0001111111", "0002222222"])
		})

		it("the documented primary-FRN rule (decision 6) picks the LATER-filed FRN, surfaced as attributes.primary_frn", async () => {
			using db = openMemory()
			await seedTwoFRNProvider(db)

			const result = await filerLookup(db, { bdcProviderID: 500_001, asOf: "2026-12-31" })

			expect(result.attributes.primary_frn).toBe("0002222222")
		})
	})

	describe("4. Temporal scoping", () => {
		const FRN_NODE = `${FilerIdentifierType.FRN}:9999999999`
		const OPEN_TARGET = `${FilerIdentifierType.Form499ID}:7000`
		const CLOSED_TARGET = `${FilerIdentifierType.HoldingCompanyName}:Closed Co`

		async function seedTemporalFixture(db: DatabaseClient<FilerDatabase>): Promise<void> {
			await createAllTables(db)
			await seedManifest(db)

			await db
				.insertInto("filer_node")
				.values([
					{ node_id: FRN_NODE, identifier_type: FilerIdentifierType.FRN, identifier_value: "9999999999" },
					{ node_id: OPEN_TARGET, identifier_type: FilerIdentifierType.Form499ID, identifier_value: "7000" },
					{
						node_id: CLOSED_TARGET,
						identifier_type: FilerIdentifierType.HoldingCompanyName,
						identifier_value: "Closed Co",
					},
				])
				.execute()

			await db
				.insertInto("filer_edge")
				.values([
					// Still open (valid_to null) — begins 2026-06-01.
					authoritativeEdge({
						from_node_id: FRN_NODE,
						to_node_id: OPEN_TARGET,
						source: "form-499",
						source_vintage: "2026-06-01",
						valid_from: "2026-06-01",
					}),
					// Closed — valid only within [2026-01-01, 2026-03-01).
					{
						...authoritativeEdge({
							from_node_id: FRN_NODE,
							to_node_id: CLOSED_TARGET,
							source: "form-499",
							source_vintage: "2026-01-01",
							valid_from: "2026-01-01",
						}),
						valid_to: "2026-03-01",
					},
				])
				.execute()
		}

		it("a lookup with asOf BEFORE an edge's valid_from excludes it", async () => {
			using db = openMemory()
			await seedTemporalFixture(db)

			const before = await filerLookup(db, { frn: toFRN("9999999999")!, asOf: "2026-05-31" })
			expect(before.identifiers.some((identifier) => identifier.value === "7000")).toBe(false)

			const onOrAfter = await filerLookup(db, { frn: toFRN("9999999999")!, asOf: "2026-06-01" })
			expect(onOrAfter.identifiers.some((identifier) => identifier.value === "7000")).toBe(true)
		})

		it("a lookup asOf on/after an edge's valid_to excludes the now-closed edge, while a date within its window still includes it", async () => {
			using db = openMemory()
			await seedTemporalFixture(db)

			const withinWindow = await filerLookup(db, { frn: toFRN("9999999999")!, asOf: "2026-02-01" })
			expect(withinWindow.identifiers.some((identifier) => identifier.value === "Closed Co")).toBe(true)

			const atClose = await filerLookup(db, { frn: toFRN("9999999999")!, asOf: "2026-03-01" })
			expect(atClose.identifiers.some((identifier) => identifier.value === "Closed Co")).toBe(false)

			const afterClose = await filerLookup(db, { frn: toFRN("9999999999")!, asOf: "2026-04-01" })
			expect(afterClose.identifiers.some((identifier) => identifier.value === "Closed Co")).toBe(false)
		})

		it("the result ALWAYS states the asOf used — both when supplied and when defaulted", async () => {
			using db = openMemory()
			await seedTemporalFixture(db)

			const explicit = await filerLookup(db, { frn: toFRN("9999999999")!, asOf: "2026-02-01" })
			expect(explicit.as_of).toBe("2026-02-01")

			const beforeCall = new Date().toISOString().slice(0, 10)
			const defaulted = await filerLookup(db, { frn: toFRN("9999999999")! })
			const afterCall = new Date().toISOString().slice(0, 10)

			expect(defaulted.as_of).toBeDefined()
			expect([beforeCall, afterCall]).toContain(defaulted.as_of)
		})
	})
})

describe("filerLookup — general reader contract", () => {
	it("throws when no identifier is supplied", async () => {
		using db = openMemory()
		await createAllTables(db)
		await seedManifest(db)

		await expect(filerLookup(db, {})).rejects.toThrow(/exactly one of `frn`, `form499ID`, `bdcProviderID`/)
	})

	it("throws when more than one identifier is supplied", async () => {
		using db = openMemory()
		await createAllTables(db)
		await seedManifest(db)

		await expect(filerLookup(db, { frn: toFRN("0001111111")!, form499ID: "100" })).rejects.toThrow(
			/exactly one of `frn`, `form499ID`, `bdcProviderID`/
		)

		await expect(filerLookup(db, { frn: toFRN("0001111111")!, form499ID: "100", bdcProviderID: 1 })).rejects.toThrow(
			/exactly one of `frn`, `form499ID`, `bdcProviderID`/
		)
	})

	it("reads the manifest FIRST — throws rather than answering unstamped when it is missing", async () => {
		using db = openMemory()
		await createAllTables(db)
		// Deliberately no manifest row.

		await expect(filerLookup(db, { form499ID: "100" })).rejects.toThrow(/expected exactly 1/)
	})

	it("throws a descriptive error when the queried identifier has no matching node", async () => {
		using db = openMemory()
		await createAllTables(db)
		await seedManifest(db)

		await expect(filerLookup(db, { form499ID: "does-not-exist" })).rejects.toThrow(
			/no form499_id node found for value "does-not-exist"/
		)
	})

	it("the result's vintage reflects filer_manifest.source_vintage", async () => {
		using db = openMemory()
		await createAllTables(db)
		await seedManifest(db)

		await db
			.insertInto("filer_node")
			.values({ node_id: "form499_id:100", identifier_type: FilerIdentifierType.Form499ID, identifier_value: "100" })
			.execute()

		const result = await filerLookup(db, { form499ID: "100" })
		expect(result.vintage).toBe(MANIFEST.source_vintage)
	})

	it("attributes reflect the LATEST source_vintage per key, mirroring cluster-filers.ts's readLatestLegalNames convention", async () => {
		using db = openMemory()
		await createAllTables(db)
		await seedManifest(db)

		await db
			.insertInto("filer_node")
			.values({ node_id: "form499_id:100", identifier_type: FilerIdentifierType.Form499ID, identifier_value: "100" })
			.execute()

		await db
			.insertInto("filer_attribute")
			.values([
				{
					node_id: "form499_id:100",
					key: "legal_name",
					value: "Old Name Co",
					source: "form-499",
					source_vintage: "2025-01-01",
				},
				{
					node_id: "form499_id:100",
					key: "legal_name",
					value: "New Name LLC",
					source: "form-499",
					source_vintage: "2026-01-01",
				},
			])
			.execute()

		const result = await filerLookup(db, { form499ID: "100" })
		expect(result.attributes.legal_name).toBe("New Name LLC")
	})

	it("resolves a node identically whether queried by frn, form499ID, or bdcProviderID", async () => {
		using db = openMemory()
		await createAllTables(db)
		await seedManifest(db)

		await db
			.insertInto("filer_node")
			.values([
				{ node_id: "frn:0001234567", identifier_type: FilerIdentifierType.FRN, identifier_value: "0001234567" },
				{ node_id: "form499_id:400", identifier_type: FilerIdentifierType.Form499ID, identifier_value: "400" },
				{
					node_id: "bdc_provider_id:800",
					identifier_type: FilerIdentifierType.BDCProviderID,
					identifier_value: "800",
				},
			])
			.execute()

		const byFRN = await filerLookup(db, { frn: toFRN("0001234567")! })
		expect(byFRN.node.node_id).toBe("frn:0001234567")

		const byForm499 = await filerLookup(db, { form499ID: "400" })
		expect(byForm499.node.node_id).toBe("form499_id:400")

		const byProvider = await filerLookup(db, { bdcProviderID: 800 })
		expect(byProvider.node.node_id).toBe("bdc_provider_id:800")
	})

	it("cluster is null when clustering has never been run", async () => {
		using db = openMemory()
		await createAllTables(db)
		await seedManifest(db)

		await db
			.insertInto("filer_node")
			.values({ node_id: "form499_id:100", identifier_type: FilerIdentifierType.Form499ID, identifier_value: "100" })
			.execute()

		const result = await filerLookup(db, { form499ID: "100" })
		expect(result.cluster).toBeNull()
	})
})

describe("pickPrimaryFRN", () => {
	const FRN_EARLY = toFRN("0001111111")!
	const FRN_LATE = toFRN("0002222222")!

	it("throws on an empty candidate list — there is no primary FRN of nothing", () => {
		expect(() => pickPrimaryFRN([])).toThrow(/at least one candidate/)
	})

	it("picks the candidate with the later filedAt, regardless of input order", () => {
		const candidates: FRNFilingRecord[] = [
			{ frn: FRN_EARLY, filedAt: "2026-01-15" },
			{ frn: FRN_LATE, filedAt: "2026-05-20" },
		]

		expect(pickPrimaryFRN(candidates)).toBe(FRN_LATE)
		expect(pickPrimaryFRN([...candidates].toReversed())).toBe(FRN_LATE)
	})

	it("keeps the first candidate on an exact filedAt tie (deterministic, not itself semantically load-bearing)", () => {
		const candidates: FRNFilingRecord[] = [
			{ frn: FRN_EARLY, filedAt: "2026-01-15" },
			{ frn: FRN_LATE, filedAt: "2026-01-15" },
		]

		expect(pickPrimaryFRN(candidates)).toBe(FRN_EARLY)
	})

	it("a single candidate is trivially its own primary", () => {
		expect(pickPrimaryFRN([{ frn: FRN_EARLY, filedAt: "2026-01-15" }])).toBe(FRN_EARLY)
	})
})
