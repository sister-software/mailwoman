/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests {@linkcode filerLookup}, {@linkcode pickPrimaryFRN} and the `filer.db` acceptance criteria.
 *
 *   Most fixtures insert rows directly into an in-memory database. Tests of builder guards and of the full
 *   pipeline call {@linkcode buildFilerDatabase} instead.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { changeMode } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { isoDate } from "@mailwoman/core/utils"
import { familyRollup } from "@mailwoman/filer/family-rollup"
import {
	filerLookup,
	pickPrimaryFRN,
	PRIMARY_FRN_DERIVATION,
	readFRNFilingCandidates,
	type FilerLookupCluster,
	type FilerLookupFamily,
	type FRNFilingRecord,
} from "@mailwoman/filer/filer-lookup"
import { toFRN } from "@mailwoman/filer/frn"
import {
	createFilerAttributeTable,
	createFilerClusterTable,
	createFilerEdgeTable,
	createFilerFamilyTable,
	createFilerManifestTable,
	createFilerNodeTable,
	FilerEdgeAssertion,
	FilerIdentifierType,
	FilerRelationship,
	type FilerDatabase,
	type FilerEdgeTable,
	type FilerFamilyTable,
	type FilerManifestTable,
} from "@mailwoman/filer/schema"
import { buildFilerDatabase, type EdgarSubsidiaryRow } from "@mailwoman/filer/sdk/build-filer"
import { clusterAuthoritativeComponents } from "@mailwoman/filer/sdk/cluster-filers"
import { mintFamilyID } from "@mailwoman/filer/sdk/family-id"
import type { Form499Row } from "@mailwoman/filer/sdk/form499"
import type { ProviderListRow } from "@mailwoman/filer/sdk/provider-list"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { Insertable } from "kysely"
import type { PathBuilderLike } from "path-ts"
import { describe, expect, it } from "vitest"

function openMemory(): DatabaseClient<FilerDatabase> {
	return DatabaseClient.temp<FilerDatabase>()
}

async function createAllTables(db: DatabaseClient<FilerDatabase>): Promise<void> {
	await createFilerNodeTable(db)
	await createFilerEdgeTable(db)
	await createFilerAttributeTable(db)
	await createFilerClusterTable(db)
	await createFilerFamilyTable(db)
	await createFilerManifestTable(db)
}

const MANIFEST: FilerManifestTable = {
	name: "filer",
	version: "2026-Q1",
	// `filerLookup` rejects schema version 1, which predates `filer_family`.
	schema_version: 2,
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
		relationship: FilerRelationship.SameEntity,
		valid_to: null,
		match_score: null,
		evidence: null,
		...overrides,
	}
}

/**
 * Opens a sealed `filer.db` from {@linkcode buildFilerDatabase} as read-only.
 */
function openFilerDB(path: PathBuilderLike): DatabaseClient<FilerDatabase> {
	return new DatabaseClient<FilerDatabase>(path, { readOnly: true })
}

function minimalForm499Row(overrides: Partial<Form499Row> = {}): Form499Row {
	return {
		form499ID: "899901",
		frn: toFRN("0001753557"),
		lastFiledAt: "2026-01-15",
		usfContributor: false,
		legalNameOfCarrier: "Check Co",
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

describe("§7-3a criteria", () => {
	describe("1. Provenance completeness (required)", () => {
		// The `satisfies` clause fails to compile when `FilerEdgeTable` gains a field missing from this list.
		// That forces a reviewer to decide whether the new field is required provenance.
		// Only `yarn typecheck:tests` checks the clause, because Vitest strips types.
		type FilerEdgeInsert = Insertable<FilerEdgeTable>

		const FILER_EDGE_INSERT_FIELDS = {
			from_node_id: true,
			to_node_id: true,
			assertion: true,
			relationship: true,
			source: true,
			source_vintage: true,
			valid_from: true,
			valid_to: true,
			match_score: true,
			evidence: true,
		} satisfies Record<keyof FilerEdgeInsert, true>

		it("the structural pin enumerates every FilerEdgeTable field, including all four required ones", () => {
			expect(Object.keys(FILER_EDGE_INSERT_FIELDS)).toHaveLength(10)

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
				// The edge has no `valid_from`.
				valid_to: null,
				match_score: null,
				evidence: null,
			} as FilerEdgeInsert

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
				// The edge has no `source`.
				source_vintage: "2026-01-15",
				valid_from: "2026-01-15",
				valid_to: null,
				match_score: null,
				evidence: null,
			} as FilerEdgeInsert

			await expect(db.insertInto("filer_edge").values(partialEdge).execute()).rejects.toThrow(
				/NOT NULL constraint failed/
			)
		})

		it("SQLite's NOT NULL alone does NOT reject an empty-string valid_from — this is why the builder-level guards below are required", async () => {
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
			await using scratch = await temporaryDirectory("filer-lookup-check1-")
			const out = scratch.path("filer.db")

			await expect(
				buildFilerDatabase({
					form499Rows: [minimalForm499Row({ lastFiledAt: "   " })],
					out,
					sourceVintage: "2026-Q1",
					buildSHA: "deadbeef",
				})
			).rejects.toThrow(/malformed.*lastFiledAt/i)

			expect(await pathExists(out)).toBe(false)
		})

		it("guards reject an empty lastFiledAt via buildFilerDatabase", async () => {
			await using scratch = await temporaryDirectory("filer-lookup-check1-")
			const out = scratch.path("filer.db")

			await expect(
				buildFilerDatabase({
					form499Rows: [minimalForm499Row({ lastFiledAt: "" })],
					out,
					sourceVintage: "2026-Q1",
					buildSHA: "deadbeef",
				})
			).rejects.toThrow(/malformed.*lastFiledAt/i)

			expect(await pathExists(out)).toBe(false)
		})

		it("guards reject a whitespace-only form499ID (not just empty) via buildFilerDatabase", async () => {
			await using scratch = await temporaryDirectory("filer-lookup-check1-")
			const out = scratch.path("filer.db")

			await expect(
				buildFilerDatabase({
					form499Rows: [minimalForm499Row({ form499ID: "   " })],
					out,
					sourceVintage: "2026-Q1",
					buildSHA: "deadbeef",
				})
			).rejects.toThrow(/malformed.*empty form499ID/i)

			expect(await pathExists(out)).toBe(false)
		})

		it("guards reject a whitespace-only provider-list frn (not just empty) via buildFilerDatabase", async () => {
			await using scratch = await temporaryDirectory("filer-lookup-check1-")
			const out = scratch.path("filer.db")

			const malformedRows: ProviderListRow[] = [
				{ providerID: 900_010, frn: "   " as ProviderListRow["frn"], holdingCompany: null },
			]

			await expect(
				buildFilerDatabase({
					providerRows: malformedRows,
					out,
					sourceVintage: "2026-Q1",
					validFrom: "2026-01-31",
					buildSHA: "deadbeef",
				})
			).rejects.toThrow(/malformed.*empty frn/i)

			expect(await pathExists(out)).toBe(false)
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

			// This inferred edge connects two separate authoritative components.
			await db
				.insertInto("filer_edge")
				.values({
					from_node_id: FORM_A,
					to_node_id: FORM_B,
					assertion: FilerEdgeAssertion.Inferred,
					relationship: FilerRelationship.SameEntity,
					source: "cluster-filers",
					source_vintage: "2026-cluster-v1",
					valid_from: "2026-01-01",
					valid_to: null,
					match_score: -5,
					evidence: stringifyJSON({ memberNodeIDs: [FORM_A, FORM_B] }),
				})
				.execute()

			// These rows match what `clusterAuthoritativeComponents` would write.
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
			// The inferred edge appears in `inferred_links` and stays out of `cluster`.
			expect(resultA.inferred_links).toEqual([{ to: FORM_B, score: -5, source: "cluster-filers" }])

			const resultB = await filerLookup(db, { form499ID: "2000", asOf: "2026-06-01" })

			expect(resultB.cluster).toEqual({ cluster_id: "authoritative:B", members: [FRN_B, FORM_B].toSorted() })
			expect(resultB.inferred_links).toEqual([{ to: FORM_A, score: -5, source: "cluster-filers" }])
		})

		it("`cluster` is asOf-scoped too — a query before the connecting authoritative edge existed reports null, matching identifiers' own emptiness at that date, instead of asserting full present-day membership regardless", async () => {
			using db = openMemory()
			await createAllTables(db)
			await seedManifest(db)

			const FRN_C = `${FilerIdentifierType.FRN}:3000000003`
			const FORM_C = `${FilerIdentifierType.Form499ID}:3000`

			await db
				.insertInto("filer_node")
				.values([
					{ node_id: FRN_C, identifier_type: FilerIdentifierType.FRN, identifier_value: "3000000003" },
					{ node_id: FORM_C, identifier_type: FilerIdentifierType.Form499ID, identifier_value: "3000" },
				])
				.execute()

			await db
				.insertInto("filer_edge")
				.values([
					authoritativeEdge({
						from_node_id: FRN_C,
						to_node_id: FORM_C,
						source: "form-499",
						source_vintage: "2026-01-01",
						valid_from: "2026-01-01",
					}),
				])
				.execute()

			// `filer_cluster` has no temporal columns, so the reader must check the edges' dates.
			await db
				.insertInto("filer_cluster")
				.values([
					{ node_id: FRN_C, cluster_id: "authoritative:C", assertion: FilerEdgeAssertion.Authoritative },
					{ node_id: FORM_C, cluster_id: "authoritative:C", assertion: FilerEdgeAssertion.Authoritative },
				])
				.execute()

			// Before the edge's `valid_from`, both `identifiers` and `cluster` are empty.
			const before = await filerLookup(db, { form499ID: "3000", asOf: "2020-01-01" })
			expect(before.identifiers).toEqual([])
			expect(before.cluster).toBeNull()

			const after = await filerLookup(db, { form499ID: "3000", asOf: "2026-06-01" })
			expect(after.identifiers.length).toBeGreaterThan(0)
			expect(after.cluster).toEqual({ cluster_id: "authoritative:C", members: [FRN_C, FORM_C].toSorted() })
		})

		// The two family rows differ only in `assertion`, `match_score` and `source`.
		// If `filerLookup` dropped either graded field from its projection,
		// `.distinct()` would merge them into one entry.
		it("filerLookup.families reports an INFERRED family membership separately from an AUTHORITATIVE one for the same family — never folded together (criterion 2, on filer_family)", async () => {
			using db = openMemory()
			await createAllTables(db)
			await seedManifest(db)

			const FRN_CHECK2 = `${FilerIdentifierType.FRN}:8080808080`
			const FAMILY_CHECK2 = "holding_company_name:check2-holdco"
			const NAMING_CHECK2 = `${FilerIdentifierType.HoldingCompanyName}:Check2 Holdco`

			await db
				.insertInto("filer_node")
				.values({ node_id: FRN_CHECK2, identifier_type: FilerIdentifierType.FRN, identifier_value: "8080808080" })
				.execute()

			await db
				.insertInto("filer_family")
				.values([
					{
						node_id: FRN_CHECK2,
						family_id: FAMILY_CHECK2,
						naming_node_id: NAMING_CHECK2,
						assertion: FilerEdgeAssertion.Authoritative,
						relationship: FilerRelationship.HoldingCompany,
						source: "form-499",
						source_vintage: "2026-01-01",
						valid_from: "2026-01-01",
						valid_to: null,
						match_score: null,
					},
					{
						node_id: FRN_CHECK2,
						family_id: FAMILY_CHECK2,
						naming_node_id: NAMING_CHECK2,
						assertion: FilerEdgeAssertion.Inferred,
						relationship: FilerRelationship.HoldingCompany,
						source: "name-match-v1",
						source_vintage: "2026-01-01",
						valid_from: "2026-01-01",
						valid_to: null,
						match_score: 0.61,
					},
				])
				.execute()

			const result = await filerLookup(db, { frn: toFRN("8080808080")!, asOf: "2026-06-01" })

			expect(result.families).toEqual([
				{
					family_id: FAMILY_CHECK2,
					relationship: FilerRelationship.HoldingCompany,
					assertion: FilerEdgeAssertion.Authoritative,
					match_score: null,
					display_names: [],
				},
				{
					family_id: FAMILY_CHECK2,
					relationship: FilerRelationship.HoldingCompany,
					assertion: FilerEdgeAssertion.Inferred,
					match_score: 0.61,
					display_names: [],
				},
			])

			// `familyRollup` reports the same grading from the family's side.
			const rollup = await familyRollup(db, { familyID: FAMILY_CHECK2, asOf: "2026-06-01" })
			expect(rollup).toHaveLength(1)

			expect(rollup[0]?.members).toEqual([
				{
					node_id: FRN_CHECK2,
					relationship: FilerRelationship.HoldingCompany,
					assertion: FilerEdgeAssertion.Authoritative,
					match_score: null,
					source: "form-499",
				},
				{
					node_id: FRN_CHECK2,
					relationship: FilerRelationship.HoldingCompany,
					assertion: FilerEdgeAssertion.Inferred,
					match_score: 0.61,
					source: "name-match-v1",
				},
			])

			// `distinct_member_count` counts member nodes, so two rows for one filer count once.
			expect(rollup[0]?.distinct_member_count).toBe(1)
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
					// One provider ID has edges to two FRNs.
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
					// Each FRN has one Form 499 filing, and FRN_LATE filed later.
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

		it("the documented primary-FRN rule (decision 6) picks the LATER-filed FRN, surfaced in the top-level primary_frn field", async () => {
			using db = openMemory()
			await seedTwoFRNProvider(db)

			const result = await filerLookup(db, { bdcProviderID: 500_001, asOf: "2026-12-31" })

			expect(result.primary_frn).toEqual({
				frn: "0002222222",
				derived_from: PRIMARY_FRN_DERIVATION,
				as_of: "2026-12-31",
			})
		})

		it("a DERIVED conclusion is never indistinguishable from a SOURCED fact: a genuine filer_attribute row named primary_frn survives untouched", async () => {
			using db = openMemory()
			await seedTwoFRNProvider(db)

			// This sourced attribute uses the `primary_frn` key.
			// The derived pick must leave it unchanged.
			await db
				.insertInto("filer_attribute")
				.values({
					node_id: PROVIDER_NODE,
					key: "primary_frn",
					value: "SOURCED-VALUE-NOT-A-REAL-FRN",
					source: "bdc-provider-list",
					source_vintage: "2026-Q2",
				})
				.execute()

			const result = await filerLookup(db, { bdcProviderID: 500_001, asOf: "2026-12-31" })

			expect(result.attributes.primary_frn).toBe("SOURCED-VALUE-NOT-A-REAL-FRN")

			expect(result.primary_frn).toEqual({
				frn: "0002222222",
				derived_from: PRIMARY_FRN_DERIVATION,
				as_of: "2026-12-31",
			})
		})

		it("primary_frn is null when cardinality is >1 but none of the FRNs has a form-499 filing to rank by", async () => {
			using db = openMemory()
			await createAllTables(db)
			await seedManifest(db)

			const bareProvider = `${FilerIdentifierType.BDCProviderID}:500009`
			const bareFRNA = `${FilerIdentifierType.FRN}:0009000001`
			const bareFRNB = `${FilerIdentifierType.FRN}:0009000002`

			await db
				.insertInto("filer_node")
				.values([
					{ node_id: bareProvider, identifier_type: FilerIdentifierType.BDCProviderID, identifier_value: "500009" },
					{ node_id: bareFRNA, identifier_type: FilerIdentifierType.FRN, identifier_value: "0009000001" },
					{ node_id: bareFRNB, identifier_type: FilerIdentifierType.FRN, identifier_value: "0009000002" },
				])
				.execute()

			await db
				.insertInto("filer_edge")
				.values([
					authoritativeEdge({
						from_node_id: bareProvider,
						to_node_id: bareFRNA,
						source: "bdc-provider-list",
						source_vintage: "2026-Q2",
						valid_from: "2026-06-30",
					}),
					authoritativeEdge({
						from_node_id: bareProvider,
						to_node_id: bareFRNB,
						source: "bdc-provider-list",
						source_vintage: "2026-Q2",
						valid_from: "2026-06-30",
					}),
				])
				.execute()

			const result = await filerLookup(db, { bdcProviderID: 500_009, asOf: "2026-12-31" })
			expect(result.primary_frn).toBeNull()
		})
	})

	describe("3b. Temporal scoping applies to the primary-FRN candidate probe too", () => {
		const PROVIDER_NODE = `${FilerIdentifierType.BDCProviderID}:500002`
		const FRN_IN_FORCE = `${FilerIdentifierType.FRN}:0003333333`
		const FRN_CLOSED = `${FilerIdentifierType.FRN}:0004444444`
		const FORM_IN_FORCE = `${FilerIdentifierType.Form499ID}:9101`
		const FORM_CLOSED = `${FilerIdentifierType.Form499ID}:9102`

		async function seedClosedVsInForce(db: DatabaseClient<FilerDatabase>): Promise<void> {
			await createAllTables(db)
			await seedManifest(db)

			await db
				.insertInto("filer_node")
				.values([
					{ node_id: PROVIDER_NODE, identifier_type: FilerIdentifierType.BDCProviderID, identifier_value: "500002" },
					{ node_id: FRN_IN_FORCE, identifier_type: FilerIdentifierType.FRN, identifier_value: "0003333333" },
					{ node_id: FRN_CLOSED, identifier_type: FilerIdentifierType.FRN, identifier_value: "0004444444" },
					{ node_id: FORM_IN_FORCE, identifier_type: FilerIdentifierType.Form499ID, identifier_value: "9101" },
					{ node_id: FORM_CLOSED, identifier_type: FilerIdentifierType.Form499ID, identifier_value: "9102" },
				])
				.execute()

			await db
				.insertInto("filer_edge")
				.values([
					// The provider edges predate both `asOf` values, so both FRNs are visible at each query.
					// Only the Form 499 edges below change state between the two dates.
					authoritativeEdge({
						from_node_id: PROVIDER_NODE,
						to_node_id: FRN_IN_FORCE,
						source: "bdc-provider-list",
						source_vintage: "2026-01-01",
						valid_from: "2026-01-01",
					}),
					authoritativeEdge({
						from_node_id: PROVIDER_NODE,
						to_node_id: FRN_CLOSED,
						source: "bdc-provider-list",
						source_vintage: "2026-01-01",
						valid_from: "2026-01-01",
					}),
					// FRN_IN_FORCE filed earlier, and its edge stays open.
					authoritativeEdge({
						from_node_id: FRN_IN_FORCE,
						to_node_id: FORM_IN_FORCE,
						source: "form-499",
						source_vintage: "2026-02-01",
						valid_from: "2026-02-01",
					}),
					// FRN_CLOSED filed later, and its edge closes on 2026-05-01.
					{
						...authoritativeEdge({
							from_node_id: FRN_CLOSED,
							to_node_id: FORM_CLOSED,
							source: "form-499",
							source_vintage: "2026-04-01",
							valid_from: "2026-04-01",
						}),
						valid_to: "2026-05-01",
					},
				])
				.execute()
		}

		it("a CLOSED-but-later-filed FRN does NOT win — the in-force-but-earlier-filed FRN is picked instead", async () => {
			using db = openMemory()
			await seedClosedVsInForce(db)

			const result = await filerLookup(db, { bdcProviderID: 500_002, asOf: "2026-06-01" })

			expect(result.primary_frn?.frn).toBe("0003333333")
		})

		it("BEFORE the closing date, the later-filed (then still-open) FRN correctly wins — proving the temporal window, not a static preference, checks the outcome", async () => {
			using db = openMemory()
			await seedClosedVsInForce(db)

			const result = await filerLookup(db, { bdcProviderID: 500_002, asOf: "2026-04-15" })

			expect(result.primary_frn?.frn).toBe("0004444444")
		})

		it("readFRNFilingCandidates itself excludes a closed edge and includes an in-force one, applying the full half-open predicate", async () => {
			using db = openMemory()
			await seedClosedVsInForce(db)

			const candidates = await readFRNFilingCandidates(db, [toFRN("0003333333")!, toFRN("0004444444")!], "2026-06-01")

			expect(candidates).toEqual([{ frn: toFRN("0003333333"), filedAt: "2026-02-01" }])
		})
	})

	describe("4. Temporal scoping", () => {
		// This test runs the real builder with a non-ISO `sourceVintage`.
		// If the builder wrote "2026-Q2" into `valid_from`, the value would sort
		// after "2026-12-31" and the `asOf` read would miss the edge.
		it("REAL builder path: a non-ISO sourceVintage never leaks into valid_from — a provider-list edge built via buildFilerDatabase stays findable asOf a real date", async () => {
			await using scratch = await temporaryDirectory("filer-lookup-check1-")
			const out = scratch.path("filer.db")

			await buildFilerDatabase({
				providerRows: [{ providerID: 600_001, frn: toFRN("0006000001")!, holdingCompany: "Realbuild Co" }],
				out,
				sourceVintage: "2026-Q2",
				validFrom: "2026-06-30",
				buildSHA: "deadbeef",
			})

			using db = openFilerDB(out)

			const result = await filerLookup(db, { bdcProviderID: 600_001, asOf: "2026-12-31" })

			const frnValues: string[] = []
			const holdingValues: string[] = []

			for (const identifier of result.identifiers) {
				if (identifier.type === FilerIdentifierType.FRN) {
					frnValues.push(identifier.value)
				}

				if (identifier.type === FilerIdentifierType.HoldingCompanyName) {
					holdingValues.push(identifier.value)
				}
			}

			expect(frnValues).toEqual(["0006000001"])

			// `identifiers` lists only `same_entity` edges.
			expect(holdingValues).toEqual([])

			// The holding company appears in `families`, which proves its edge passed the `asOf` filter.
			expect(result.families).toHaveLength(1)
			expect(result.families[0]?.relationship).toBe(FilerRelationship.HoldingCompany)
			expect(result.families[0]?.family_id.startsWith(`${FilerIdentifierType.HoldingCompanyName}:`)).toBe(true)
		})

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
					// This edge opens on 2026-06-01 and never closes.
					authoritativeEdge({
						from_node_id: FRN_NODE,
						to_node_id: OPEN_TARGET,
						source: "form-499",
						source_vintage: "2026-06-01",
						valid_from: "2026-06-01",
					}),
					// This edge is valid in the half-open range [2026-01-01, 2026-03-01).
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

			const beforeCall = isoDate()
			const defaulted = await filerLookup(db, { frn: toFRN("9999999999")! })
			const afterCall = isoDate()

			expect(defaulted.as_of).toBeDefined()
			expect([beforeCall, afterCall]).toContain(defaulted.as_of)
		})
	})
})

// These criteria keep family membership apart from entity clusters and graded evidence apart from filings.
describe("§7-3b criteria", () => {
	describe("1. Family and entity cluster are never conflated (required)", () => {
		// `FilerLookupCluster` and `FilerLookupFamily` share no fields,
		// so assigning one to the other fails to compile.
		// Only `yarn typecheck:tests` checks this.
		// The next test covers the same rule at runtime.
		it("FilerLookupCluster and FilerLookupFamily are structurally incompatible types", () => {
			const clusterShaped: FilerLookupCluster = { cluster_id: "authoritative:x", members: ["a", "b"] }

			// @ts-expect-error — a cluster-shaped value (cluster_id/members) must not satisfy the family shape
			// (family_id/relationship): the two rollups are never structurally interchangeable.
			const misassigned: FilerLookupFamily = clusterShaped

			expect(misassigned).toBe(clusterShaped)
		})

		// A and B form one entity cluster.
		// A and FAMILY_ONLY share a holding company.
		// If families leaked into clusters, FAMILY_ONLY would appear in A's cluster.
		// If clusters leaked into families, B would appear in A's families.
		it("a family membership is never returned as an entity-cluster member, and vice versa", async () => {
			using db = openMemory()
			await createAllTables(db)
			await seedManifest(db)

			const FRN_CLUSTER_A = `${FilerIdentifierType.FRN}:1010101010`
			const FRN_CLUSTER_B = `${FilerIdentifierType.FRN}:2020202020`
			const FRN_FAMILY_ONLY = `${FilerIdentifierType.FRN}:3030303030`

			await db
				.insertInto("filer_node")
				.values([
					{ node_id: FRN_CLUSTER_A, identifier_type: FilerIdentifierType.FRN, identifier_value: "1010101010" },
					{ node_id: FRN_CLUSTER_B, identifier_type: FilerIdentifierType.FRN, identifier_value: "2020202020" },
					{ node_id: FRN_FAMILY_ONLY, identifier_type: FilerIdentifierType.FRN, identifier_value: "3030303030" },
				])
				.execute()

			// A and B are two identifiers of one filer.
			await db
				.insertInto("filer_edge")
				.values(
					authoritativeEdge({
						from_node_id: FRN_CLUSTER_A,
						to_node_id: FRN_CLUSTER_B,
						source: "form-499",
						source_vintage: "2026-01-01",
						valid_from: "2026-01-01",
					})
				)
				.execute()

			await db
				.insertInto("filer_cluster")
				.values([
					{ node_id: FRN_CLUSTER_A, cluster_id: "authoritative:AB", assertion: FilerEdgeAssertion.Authoritative },
					{ node_id: FRN_CLUSTER_B, cluster_id: "authoritative:AB", assertion: FilerEdgeAssertion.Authoritative },
				])
				.execute()

			// A and FAMILY_ONLY share a holding company.
			// FAMILY_ONLY sits outside A's entity cluster.
			await db
				.insertInto("filer_family")
				.values([
					{
						node_id: FRN_CLUSTER_A,
						family_id: "holding_company_name:bigco-inc",
						naming_node_id: `${FilerIdentifierType.HoldingCompanyName}:BigCo Inc`,
						assertion: FilerEdgeAssertion.Authoritative,
						relationship: FilerRelationship.HoldingCompany,
						source: "form-499",
						source_vintage: "2026-01-01",
						valid_from: "2026-01-01",
						valid_to: null,
					},
					{
						node_id: FRN_FAMILY_ONLY,
						family_id: "holding_company_name:bigco-inc",
						naming_node_id: `${FilerIdentifierType.HoldingCompanyName}:BigCo Inc`,
						assertion: FilerEdgeAssertion.Authoritative,
						relationship: FilerRelationship.HoldingCompany,
						source: "form-499",
						source_vintage: "2026-01-01",
						valid_from: "2026-01-01",
						valid_to: null,
					},
				])
				.execute()

			const resultA = await filerLookup(db, { frn: toFRN("1010101010")!, asOf: "2026-06-01" })

			expect(resultA.cluster).toEqual({ cluster_id: "authoritative:AB", members: [FRN_CLUSTER_A, FRN_CLUSTER_B] })

			// `display_names` is empty because the fixture writes no edge for the family row.
			expect(resultA.families).toEqual([
				{
					family_id: "holding_company_name:bigco-inc",
					relationship: FilerRelationship.HoldingCompany,
					assertion: FilerEdgeAssertion.Authoritative,
					match_score: null,
					display_names: [],
				},
			])

			// B shares A's cluster but has no family row, so its `families` list is empty.
			const resultB = await filerLookup(db, { frn: toFRN("2020202020")!, asOf: "2026-06-01" })
			expect(resultB.cluster).toEqual({ cluster_id: "authoritative:AB", members: [FRN_CLUSTER_A, FRN_CLUSTER_B] })
			expect(resultB.families).toEqual([])

			// FAMILY_ONLY shares A's family but has no cluster row, so its `cluster` is null.
			const resultFamilyOnly = await filerLookup(db, { frn: toFRN("3030303030")!, asOf: "2026-06-01" })
			expect(resultFamilyOnly.cluster).toBeNull()

			expect(resultFamilyOnly.families).toEqual([
				{
					family_id: "holding_company_name:bigco-inc",
					relationship: FilerRelationship.HoldingCompany,
					assertion: FilerEdgeAssertion.Authoritative,
					match_score: null,
					display_names: [],
				},
			])
		})

		// This test runs the real builder and clusterer.
		// `readAuthoritativeGroups` must follow only `same_entity` edges.
		// If it also followed `HoldingCompany` edges, the three filers would merge into one cluster.
		it("REAL builder + REAL clusterAuthoritativeComponents: 3 FRNs sharing one holding company yield 3 distinct entity clusters and 1 shared family — never merged", async () => {
			await using scratch = await temporaryDirectory("filer-lookup-check1-")
			const out = scratch.path("filer.db")

			const SHARED_HOLDING = "Real Pipeline Holdco Inc"

			const FRN_1 = toFRN("0009200001")!
			const FRN_2 = toFRN("0009200002")!
			const FRN_3 = toFRN("0009200003")!

			await buildFilerDatabase({
				form499Rows: [
					minimalForm499Row({
						form499ID: "920001",
						frn: FRN_1,
						holdingCompany: SHARED_HOLDING,
						lastFiledAt: "2026-05-01",
					}),
					minimalForm499Row({
						form499ID: "920002",
						frn: FRN_2,
						holdingCompany: SHARED_HOLDING,
						lastFiledAt: "2026-05-01",
					}),
					minimalForm499Row({
						form499ID: "920003",
						frn: FRN_3,
						holdingCompany: SHARED_HOLDING,
						lastFiledAt: "2026-05-01",
					}),
				],
				out,
				sourceVintage: "2026-Q2",
				buildSHA: "deadbeef",
			})

			// The builder seals the file read-only, and the clusterer needs to write to it.
			await changeMode(out, 0o644)
			using db = new DatabaseClient<FilerDatabase>(out)

			await clusterAuthoritativeComponents(db)

			const frnNodeIDs: string[] = []

			for (const frn of [FRN_1, FRN_2, FRN_3]) {
				frnNodeIDs.push(`${FilerIdentifierType.FRN}:${frn}`)
			}

			const clusterRows = await db
				.selectFrom("filer_cluster")
				.select(["node_id", "cluster_id"])
				.where("node_id", "in", frnNodeIDs)
				.where("assertion", "=", FilerEdgeAssertion.Authoritative)
				.execute()

			const distinctClusterIDs = new Set<string>()

			for (const row of clusterRows) {
				distinctClusterIDs.add(row.cluster_id)
			}

			expect(distinctClusterIDs.size).toBe(3)

			const asOf = "2026-12-31"

			const result1 = await filerLookup(db, { frn: FRN_1, asOf })
			const result2 = await filerLookup(db, { frn: FRN_2, asOf })
			const result3 = await filerLookup(db, { frn: FRN_3, asOf })

			// Each FRN's cluster holds only that FRN and its own Form 499 ID.
			expect(result1.cluster?.members).not.toContain(`${FilerIdentifierType.FRN}:${FRN_2}`)
			expect(result1.cluster?.members).not.toContain(`${FilerIdentifierType.FRN}:${FRN_3}`)
			expect(result2.cluster?.members).not.toContain(`${FilerIdentifierType.FRN}:${FRN_1}`)
			expect(result2.cluster?.members).not.toContain(`${FilerIdentifierType.FRN}:${FRN_3}`)
			expect(result3.cluster?.members).not.toContain(`${FilerIdentifierType.FRN}:${FRN_1}`)
			expect(result3.cluster?.members).not.toContain(`${FilerIdentifierType.FRN}:${FRN_2}`)

			expect(result1.cluster?.cluster_id).not.toBe(result2.cluster?.cluster_id)
			expect(result1.cluster?.cluster_id).not.toBe(result3.cluster?.cluster_id)
			expect(result2.cluster?.cluster_id).not.toBe(result3.cluster?.cluster_id)

			// All three FRNs share one family.
			expect(result1.families).toHaveLength(1)
			expect(result2.families).toHaveLength(1)
			expect(result3.families).toHaveLength(1)

			const sharedFamilyID = result1.families[0]?.family_id

			expect(result2.families[0]?.family_id).toBe(sharedFamilyID)
			expect(result3.families[0]?.family_id).toBe(sharedFamilyID)

			// All three filers used the same spelling, so `display_names` has one entry.
			expect(result1.families[0]?.display_names).toEqual([SHARED_HOLDING])
			expect(result2.families[0]?.display_names).toEqual([SHARED_HOLDING])
			expect(result3.families[0]?.display_names).toEqual([SHARED_HOLDING])

			const rollup = await familyRollup(db, { familyID: sharedFamilyID!, asOf })
			expect(rollup).toHaveLength(1)
			expect(rollup[0]?.distinct_member_count).toBe(3)
			expect(rollup[0]?.display_names).toEqual([SHARED_HOLDING])

			const memberFRNValues: string[] = []

			for (const member of rollup[0]?.members ?? []) {
				memberFRNValues.push(member.node_id)
			}

			expect(memberFRNValues.toSorted()).toEqual(frnNodeIDs.toSorted())
		})

		// "Acme Corp" and "Acme Corporation, LLC" canonicalize to the same family.
		// Both spellings must appear in `display_names`, sorted.
		it("REAL builder, multi-spelling family: two raw holding-company spellings that canonicalize identically both survive in display_names, sorted — never collapsed to one", async () => {
			await using scratch = await temporaryDirectory("filer-lookup-check1-")
			const out = scratch.path("filer.db")

			const FRN_SPELLING_1 = toFRN("0009300001")!
			const FRN_SPELLING_2 = toFRN("0009300002")!

			await buildFilerDatabase({
				form499Rows: [
					minimalForm499Row({
						form499ID: "930001",
						frn: FRN_SPELLING_1,
						holdingCompany: "Acme Corp",
						lastFiledAt: "2026-01-01",
					}),
					minimalForm499Row({
						form499ID: "930002",
						frn: FRN_SPELLING_2,
						holdingCompany: "Acme Corporation, LLC",
						lastFiledAt: "2026-02-01",
					}),
				],
				out,
				sourceVintage: "2026-Q2",
				buildSHA: "deadbeef",
			})

			using db = openFilerDB(out)

			const result1 = await filerLookup(db, { frn: FRN_SPELLING_1, asOf: "2026-12-31" })
			const result2 = await filerLookup(db, { frn: FRN_SPELLING_2, asOf: "2026-12-31" })

			expect(result1.families).toHaveLength(1)
			expect(result2.families).toHaveLength(1)

			const sharedFamilyID = result1.families[0]?.family_id
			expect(result2.families[0]?.family_id).toBe(sharedFamilyID)

			const expectedSpellings = ["Acme Corp", "Acme Corporation, LLC"].toSorted()

			expect(result1.families[0]?.display_names).toEqual(expectedSpellings)
			expect(result2.families[0]?.display_names).toEqual(expectedSpellings)

			const rollup = await familyRollup(db, { familyID: sharedFamilyID!, asOf: "2026-12-31" })
			expect(rollup[0]?.display_names).toEqual(expectedSpellings)
		})

		// One FRN files two rows on the same day with two spellings of one company.
		// The two family rows differ only in `naming_node_id`, which is why that
		// column is part of the primary key.
		// The test also checks that the extra row does not inflate `families` or `distinct_member_count`.
		it("REAL builder, one filer reporting TWO spellings of one family: both survive in display_names, families stays one entry, distinct_member_count stays 1", async () => {
			await using scratch = await temporaryDirectory("filer-lookup-check1-")
			const out = scratch.path("filer.db")

			const FRN_TWO_SPELLINGS = toFRN("0009500001")!

			await buildFilerDatabase({
				form499Rows: [
					minimalForm499Row({
						form499ID: "950001",
						frn: FRN_TWO_SPELLINGS,
						holdingCompany: "Acme Corp",
						lastFiledAt: "2026-05-01",
					}),
					minimalForm499Row({
						form499ID: "950002",
						frn: FRN_TWO_SPELLINGS,
						holdingCompany: "Acme Corporation, LLC",
						lastFiledAt: "2026-05-01",
					}),
				],
				out,
				sourceVintage: "2026-Q2",
				buildSHA: "deadbeef",
			})

			using db = openFilerDB(out)

			const familyID = mintFamilyID(FilerIdentifierType.HoldingCompanyName, "Acme Corp")!
			const frnNodeID = `${FilerIdentifierType.FRN}:${FRN_TWO_SPELLINGS}`

			const familyRows = await db
				.selectFrom("filer_family")
				.selectAll()
				.where("node_id", "=", frnNodeID)
				.orderBy("naming_node_id")
				.execute()

			expect(familyRows).toHaveLength(2)

			const namingNodeIDs: string[] = []
			const distinctFamilyIDs = new Set<string>()

			for (const row of familyRows) {
				namingNodeIDs.push(row.naming_node_id)
				distinctFamilyIDs.add(row.family_id)
			}

			expect(distinctFamilyIDs).toEqual(new Set([familyID]))

			expect(namingNodeIDs).toEqual([
				`${FilerIdentifierType.HoldingCompanyName}:Acme Corp`,
				`${FilerIdentifierType.HoldingCompanyName}:Acme Corporation, LLC`,
			])

			const expectedSpellings = ["Acme Corp", "Acme Corporation, LLC"].toSorted()

			const result = await filerLookup(db, { frn: FRN_TWO_SPELLINGS, asOf: "2026-12-31" })

			expect(result.families).toHaveLength(1)
			expect(result.families[0]?.family_id).toBe(familyID)
			expect(result.families[0]?.display_names).toEqual(expectedSpellings)

			const rollup = await familyRollup(db, { familyID, asOf: "2026-12-31" })

			expect(rollup).toHaveLength(1)
			expect(rollup[0]?.display_names).toEqual(expectedSpellings)

			// `members` has one entry per row, and `distinct_member_count` counts nodes.
			expect(rollup[0]?.distinct_member_count).toBe(1)

			const memberNodeIDs: string[] = []

			for (const member of rollup[0]?.members ?? []) {
				memberNodeIDs.push(member.node_id)
			}

			expect(memberNodeIDs).toEqual([frnNodeID, frnNodeID])
		})

		// In the next two tests, one node has two holding-company edges with the same source and date.
		// Each family must list only the name of its own holding company.
		// The provider-list path and the Form 499 path both produce this shape.
		it("display_names never leaks across a DIFFERENT family: REAL builder, provider-list path — one providerID with two DIFFERENT holding companies under the same source+valid_from never cross-contaminates each family's display_names", async () => {
			await using scratch = await temporaryDirectory("filer-lookup-check1-")
			const out = scratch.path("filer.db")

			const FRN_SHARED = toFRN("0009400001")!

			await buildFilerDatabase({
				providerRows: [
					{ providerID: 940_001, frn: FRN_SHARED, holdingCompany: "Alpha Holdco" },
					{ providerID: 940_001, frn: FRN_SHARED, holdingCompany: "Zenith Unrelated Group" },
				],
				out,
				sourceVintage: "2026-Q2",
				validFrom: "2026-06-30",
				buildSHA: "deadbeef",
			})

			using db = openFilerDB(out)

			const result = await filerLookup(db, { bdcProviderID: 940_001, asOf: "2026-12-31" })

			expect(result.families).toHaveLength(2)

			const familyIDAlpha = mintFamilyID(FilerIdentifierType.HoldingCompanyName, "Alpha Holdco")!
			const familyIDZenith = mintFamilyID(FilerIdentifierType.HoldingCompanyName, "Zenith Unrelated Group")!

			const familyByID = new Map<string, (typeof result.families)[number]>()

			for (const family of result.families) {
				familyByID.set(family.family_id, family)
			}

			expect(familyByID.get(familyIDAlpha)?.display_names).toEqual(["Alpha Holdco"])
			expect(familyByID.get(familyIDZenith)?.display_names).toEqual(["Zenith Unrelated Group"])

			const rollupAlpha = await familyRollup(db, { familyID: familyIDAlpha, asOf: "2026-12-31" })
			const rollupZenith = await familyRollup(db, { familyID: familyIDZenith, asOf: "2026-12-31" })

			expect(rollupAlpha[0]?.display_names).toEqual(["Alpha Holdco"])
			expect(rollupZenith[0]?.display_names).toEqual(["Zenith Unrelated Group"])
		})

		it("display_names never leaks across a DIFFERENT family: REAL builder, 499 path — one FRN with two DIFFERENT holding companies filed the same day never cross-contaminates each family's display_names", async () => {
			await using scratch = await temporaryDirectory("filer-lookup-check1-")
			const out = scratch.path("filer.db")

			const FRN_SHARED = toFRN("0009400002")!

			await buildFilerDatabase({
				form499Rows: [
					minimalForm499Row({
						form499ID: "940201",
						frn: FRN_SHARED,
						holdingCompany: "Alpha Holdco",
						lastFiledAt: "2026-05-01",
					}),
					minimalForm499Row({
						form499ID: "940202",
						frn: FRN_SHARED,
						holdingCompany: "Zenith Unrelated Group",
						lastFiledAt: "2026-05-01",
					}),
				],
				out,
				sourceVintage: "2026-Q2",
				buildSHA: "deadbeef",
			})

			using db = openFilerDB(out)

			const result = await filerLookup(db, { frn: FRN_SHARED, asOf: "2026-12-31" })

			expect(result.families).toHaveLength(2)

			const familyIDAlpha = mintFamilyID(FilerIdentifierType.HoldingCompanyName, "Alpha Holdco")!
			const familyIDZenith = mintFamilyID(FilerIdentifierType.HoldingCompanyName, "Zenith Unrelated Group")!

			const familyByID = new Map<string, (typeof result.families)[number]>()

			for (const family of result.families) {
				familyByID.set(family.family_id, family)
			}

			expect(familyByID.get(familyIDAlpha)?.display_names).toEqual(["Alpha Holdco"])
			expect(familyByID.get(familyIDZenith)?.display_names).toEqual(["Zenith Unrelated Group"])
		})
	})

	describe("2. Relationship kind + provenance mandatory on every family row", () => {
		// The `satisfies` clause fails to compile when `FilerFamilyTable` gains a field missing from this list.
		// Only `yarn typecheck:tests` checks it.
		type FilerFamilyInsert = Insertable<FilerFamilyTable>

		const FILER_FAMILY_INSERT_FIELDS = {
			node_id: true,
			family_id: true,
			naming_node_id: true,
			assertion: true,
			relationship: true,
			source: true,
			source_vintage: true,
			valid_from: true,
			valid_to: true,
			match_score: true,
		} satisfies Record<keyof FilerFamilyInsert, true>

		it("the structural pin enumerates every FilerFamilyTable field, including naming_node_id/assertion/relationship/source/source_vintage/valid_from", () => {
			expect(Object.keys(FILER_FAMILY_INSERT_FIELDS)).toHaveLength(10)

			expect(FILER_FAMILY_INSERT_FIELDS).toMatchObject({
				// `naming_node_id` records which company node's raw name produced the family ID.
				naming_node_id: true,
				// `assertion` separates a filed disclosure from an inferred name match.
				assertion: true,
				relationship: true,
				source: true,
				source_vintage: true,
				valid_from: true,
			})
		})

		it("runtime: a filer_family insert missing relationship is rejected", async () => {
			using db = openMemory()
			await createAllTables(db)

			await db
				.insertInto("filer_node")
				.values({ node_id: "frn:4040404040", identifier_type: FilerIdentifierType.FRN, identifier_value: "4040404040" })
				.execute()

			const partialFamily = {
				node_id: "frn:4040404040",
				family_id: "holding_company_name:check2-co",
				naming_node_id: `${FilerIdentifierType.HoldingCompanyName}:Check2 Co`,
				assertion: FilerEdgeAssertion.Authoritative,
				// The row has no `relationship`.
				source: "form-499",
				source_vintage: "2026-01-01",
				valid_from: "2026-01-01",
				valid_to: null,
			} as FilerFamilyInsert

			await expect(db.insertInto("filer_family").values(partialFamily).execute()).rejects.toThrow(
				/NOT NULL constraint failed/
			)
		})

		it("runtime: a filer_family insert missing source is rejected", async () => {
			using db = openMemory()
			await createAllTables(db)

			await db
				.insertInto("filer_node")
				.values({ node_id: "frn:5050505050", identifier_type: FilerIdentifierType.FRN, identifier_value: "5050505050" })
				.execute()

			const partialFamily = {
				node_id: "frn:5050505050",
				family_id: "holding_company_name:check2-co",
				naming_node_id: `${FilerIdentifierType.HoldingCompanyName}:Check2 Co`,
				assertion: FilerEdgeAssertion.Authoritative,
				relationship: FilerRelationship.HoldingCompany,
				// The row has no `source`.
				source_vintage: "2026-01-01",
				valid_from: "2026-01-01",
				valid_to: null,
			} as FilerFamilyInsert

			await expect(db.insertInto("filer_family").values(partialFamily).execute()).rejects.toThrow(
				/NOT NULL constraint failed/
			)
		})

		it("SQLite's NOT NULL alone does NOT reject an empty-string relationship — the CHECK constraint is what closes that gap (the 3a lesson, criterion 2)", async () => {
			using db = openMemory()
			await createAllTables(db)

			await db
				.insertInto("filer_node")
				.values({ node_id: "frn:6060606060", identifier_type: FilerIdentifierType.FRN, identifier_value: "6060606060" })
				.execute()

			await expect(
				db
					.insertInto("filer_family")
					.values({
						node_id: "frn:6060606060",
						family_id: "holding_company_name:check2-co",
						naming_node_id: `${FilerIdentifierType.HoldingCompanyName}:Check2 Co`,
						assertion: FilerEdgeAssertion.Authoritative,
						relationship: "",
						source: "form-499",
						source_vintage: "2026-01-01",
						valid_from: "2026-01-01",
						valid_to: null,
					})
					.execute()
			).rejects.toThrow(/CHECK constraint failed/)
		})

		it("rejects a whitespace-only relationship too (not just empty)", async () => {
			using db = openMemory()
			await createAllTables(db)

			await db
				.insertInto("filer_node")
				.values({ node_id: "frn:7070707070", identifier_type: FilerIdentifierType.FRN, identifier_value: "7070707070" })
				.execute()

			await expect(
				db
					.insertInto("filer_family")
					.values({
						node_id: "frn:7070707070",
						family_id: "holding_company_name:check2-co",
						naming_node_id: `${FilerIdentifierType.HoldingCompanyName}:Check2 Co`,
						assertion: FilerEdgeAssertion.Authoritative,
						relationship: "   ",
						source: "form-499",
						source_vintage: "2026-01-01",
						valid_from: "2026-01-01",
						valid_to: null,
					})
					.execute()
			).rejects.toThrow(/CHECK constraint failed/)
		})
	})

	// `filerLookup` and `familyRollup` each apply their own `asOf` filter.
	// These tests cover the one in `filerLookup`.
	describe("families is asOf-scoped", () => {
		const FRN_TEMPORAL = `${FilerIdentifierType.FRN}:4040404050`
		const FAMILY_ID_TEMPORAL = "holding_company_name:temporal-co"
		const NAMING_NODE_TEMPORAL = `${FilerIdentifierType.HoldingCompanyName}:Temporal Co`

		it("excludes a family membership before its valid_from", async () => {
			using db = openMemory()
			await createAllTables(db)
			await seedManifest(db)

			await db
				.insertInto("filer_node")
				.values({ node_id: FRN_TEMPORAL, identifier_type: FilerIdentifierType.FRN, identifier_value: "4040404050" })
				.execute()

			await db
				.insertInto("filer_family")
				.values({
					node_id: FRN_TEMPORAL,
					family_id: FAMILY_ID_TEMPORAL,
					naming_node_id: NAMING_NODE_TEMPORAL,
					assertion: FilerEdgeAssertion.Authoritative,
					relationship: FilerRelationship.HoldingCompany,
					source: "form-499",
					source_vintage: "2026-06-01",
					valid_from: "2026-06-01",
					valid_to: null,
				})
				.execute()

			const before = await filerLookup(db, { frn: toFRN("4040404050")!, asOf: "2026-05-31" })
			expect(before.families).toEqual([])

			const onOrAfter = await filerLookup(db, { frn: toFRN("4040404050")!, asOf: "2026-06-01" })

			// `display_names` is empty because the fixture writes no edge.
			expect(onOrAfter.families).toEqual([
				{
					family_id: FAMILY_ID_TEMPORAL,
					relationship: FilerRelationship.HoldingCompany,
					assertion: FilerEdgeAssertion.Authoritative,
					match_score: null,
					display_names: [],
				},
			])
		})

		it("excludes a CLOSED family membership on/after its valid_to, while a date within its window still includes it", async () => {
			using db = openMemory()
			await createAllTables(db)
			await seedManifest(db)

			await db
				.insertInto("filer_node")
				.values({ node_id: FRN_TEMPORAL, identifier_type: FilerIdentifierType.FRN, identifier_value: "4040404050" })
				.execute()

			await db
				.insertInto("filer_family")
				.values({
					node_id: FRN_TEMPORAL,
					family_id: FAMILY_ID_TEMPORAL,
					naming_node_id: NAMING_NODE_TEMPORAL,
					assertion: FilerEdgeAssertion.Authoritative,
					relationship: FilerRelationship.HoldingCompany,
					source: "form-499",
					source_vintage: "2026-01-01",
					valid_from: "2026-01-01",
					valid_to: "2026-03-01",
				})
				.execute()

			const withinWindow = await filerLookup(db, { frn: toFRN("4040404050")!, asOf: "2026-02-01" })

			// `display_names` is empty because the fixture writes no edge.
			expect(withinWindow.families).toEqual([
				{
					family_id: FAMILY_ID_TEMPORAL,
					relationship: FilerRelationship.HoldingCompany,
					assertion: FilerEdgeAssertion.Authoritative,
					match_score: null,
					display_names: [],
				},
			])

			const atClose = await filerLookup(db, { frn: toFRN("4040404050")!, asOf: "2026-03-01" })
			expect(atClose.families).toEqual([])

			const afterClose = await filerLookup(db, { frn: toFRN("4040404050")!, asOf: "2026-04-01" })
			expect(afterClose.families).toEqual([])
		})
	})

	// This block runs the real builder with EDGAR rows.
	// The EDGAR relationships must stay out of clusters and `identifiers` and must appear in `families`.
	// The positive check keeps the test from passing when the EDGAR path writes nothing.
	describe("2. EDGAR-sourced families extend checks 1-2", () => {
		it("an inferred EDGAR subsidiary relationship never leaks into entity clustering or identifiers, but DOES surface as a family via familyRollup/filerLookup.families", async () => {
			await using scratch = await temporaryDirectory("filer-lookup-check1-")
			const out = scratch.path("filer.db")

			const FRN_SUBSIDIARY = toFRN("0009600001")!
			const CIK_PARENT = "0001234567"

			const edgarRows: EdgarSubsidiaryRow[] = [
				{ cik: CIK_PARENT, subsidiaryName: "Cascade Fiber Networks LLC", filingDate: "2026-04-01" },
			]

			await buildFilerDatabase({
				form499Rows: [
					minimalForm499Row({
						form499ID: "960001",
						frn: FRN_SUBSIDIARY,
						legalNameOfCarrier: "Cascade Fiber Networks LLC",
						lastFiledAt: "2026-03-01",
					}),
				],
				edgarRows,
				out,
				sourceVintage: "2026-Q2",
				buildSHA: "deadbeef",
			})

			await changeMode(out, 0o644)
			using db = new DatabaseClient<FilerDatabase>(out)

			await clusterAuthoritativeComponents(db)

			const asOf = "2026-12-31"
			const cikNodeID = `${FilerIdentifierType.CIK}:${CIK_PARENT}`

			const result = await filerLookup(db, { frn: FRN_SUBSIDIARY, asOf })

			// The CIK stays out of the FRN's cluster and out of `identifiers`.
			expect(result.cluster?.members).not.toContain(cikNodeID)

			let hasCIKIdentifier = false

			for (const identifier of result.identifiers) {
				if (identifier.type === FilerIdentifierType.CIK) {
					hasCIKIdentifier = true
				}
			}

			expect(hasCIKIdentifier).toBe(false)

			// The membership appears in `families` as an inference with a match score.
			expect(result.families).toEqual([
				{
					family_id: cikNodeID,
					relationship: FilerRelationship.ParentCompany,
					assertion: FilerEdgeAssertion.Inferred,
					match_score: 0.9,
					display_names: ["0001234567"],
				},
			])

			// Every node gets a cluster.
			// The CIK's disclosure edge is a `Subsidiary` edge, so the CIK forms a singleton cluster.
			const cikCluster = await db
				.selectFrom("filer_cluster")
				.selectAll()
				.where("node_id", "=", cikNodeID)
				.where("assertion", "=", FilerEdgeAssertion.Authoritative)
				.executeTakeFirstOrThrow()

			expect(cikCluster.cluster_id).not.toBe(result.cluster?.cluster_id)

			const rollup = await familyRollup(db, { familyID: cikNodeID, asOf })
			expect(rollup).toHaveLength(1)

			// The `source` alone cannot mark the row as inferred because the EDGAR source
			// also writes an authoritative disclosure edge.
			expect(rollup[0]?.members).toEqual([
				{
					node_id: `${FilerIdentifierType.FRN}:${FRN_SUBSIDIARY}`,
					relationship: FilerRelationship.ParentCompany,
					assertion: FilerEdgeAssertion.Inferred,
					match_score: 0.9,
					source: "edgar-exhibit-21",
				},
			])
		})
	})
})

describe("filerLookup — general reader interface", () => {
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
		// The test writes no manifest row.

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

	it("keeps the first candidate on an exact filedAt tie (deterministic, not itself semantically required)", () => {
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
