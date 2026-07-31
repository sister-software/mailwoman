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

import { chmodSync, existsSync } from "node:fs"
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
} from "../schema.ts"
import { buildFilerDatabase } from "./build-filer.ts"
import { clusterAuthoritativeComponents } from "./cluster-filers.ts"
import { mintFamilyID } from "./family-id.ts"
import { familyRollup } from "./family-rollup.ts"
import {
	filerLookup,
	pickPrimaryFRN,
	PRIMARY_FRN_DERIVATION,
	readFRNFilingCandidates,
	type FilerLookupCluster,
	type FilerLookupFamily,
	type FRNFilingRecord,
} from "./filer-lookup.ts"
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
	await createFilerFamilyTable(db)
	await createFilerManifestTable(db)
}

const MANIFEST: FilerManifestTable = {
	name: "filer",
	version: "2026-Q1",
	// 2, not 1 (task 3 fix round 1, IMPORTANT-3) — filerLookup now unconditionally queries filer_family and refuses
	// a manifest reporting a schema_version that predates it (see the dedicated schema-version-guard test below).
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
 * Opens a REAL (on-disk, sealed) `filer.db` read-only — mirrors `build-filer.test.ts`'s own `openFilerDB` helper. Used
 * only by the tests that go through {@linkcode buildFilerDatabase} itself (gate 1's builder-guard sub-tests, and the
 * fixture-blindness-closing gate 4 test below) rather than the in-memory hand-written fixtures the rest of this suite
 * uses.
 */
function openFilerDB(path: string): DatabaseClient<FilerDatabase> {
	return new DatabaseClient<FilerDatabase>({ database: new DatabaseSync(path, { readOnly: true }) })
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
			relationship: true,
			source: true,
			source_vintage: true,
			valid_from: true,
			valid_to: true,
			match_score: true,
			evidence: true,
		} satisfies Record<keyof FilerEdgeInsert, true>

		it("the structural pin enumerates every FilerEdgeTable field, including all four load-bearing ones", () => {
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
						validFrom: "2026-01-31",
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
					relationship: FilerRelationship.SameEntity,
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

		it("`cluster` is asOf-scoped too — a query before the connecting authoritative edge existed reports null, matching identifiers' own emptiness at that date, instead of asserting full present-day membership regardless (review fix, IMPORTANT-2)", async () => {
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

			// Fixture-built directly, exactly as clusterAuthoritativeComponents WOULD leave it — filer_cluster carries
			// NO temporal columns of its own (schema.ts), so this snapshot alone can't distinguish "asOf 2020" from
			// "asOf 2026".
			await db
				.insertInto("filer_cluster")
				.values([
					{ node_id: FRN_C, cluster_id: "authoritative:C", assertion: FilerEdgeAssertion.Authoritative },
					{ node_id: FORM_C, cluster_id: "authoritative:C", assertion: FilerEdgeAssertion.Authoritative },
				])
				.execute()

			// Reviewer probe: asOf BEFORE the connecting edge's valid_from — identifiers is already empty here...
			const before = await filerLookup(db, { form499ID: "3000", asOf: "2020-01-01" })
			expect(before.identifiers).toEqual([])
			// ...and cluster must NOT contradict that by asserting full present-day membership anyway.
			expect(before.cluster).toBeNull()

			// asOf AFTER the edge's valid_from — both identifiers and cluster agree the relationship holds.
			const after = await filerLookup(db, { form499ID: "3000", asOf: "2026-06-01" })
			expect(after.identifiers.length).toBeGreaterThan(0)
			expect(after.cluster).toEqual({ cluster_id: "authoritative:C", members: [FRN_C, FORM_C].toSorted() })
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

		it("a DERIVED conclusion is never indistinguishable from a SOURCED fact: a genuine filer_attribute row named primary_frn survives untouched (review fix, round 1, IMPORTANT-1)", async () => {
			using db = openMemory()
			await seedTwoFRNProvider(db)

			// A real, provenanced attribute happening to share the same key the derived pick used to be written under
			// before the fix — proves `attributes` is never touched by the primary-FRN computation, and the two are
			// simultaneously readable without one clobbering the other.
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

	describe("3b. Temporal scoping applies to the primary-FRN candidate probe too (review fix, round 1, IMPORTANT-2)", () => {
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
					// Provider↔FRN edges dated well before either test's asOf — the primary-FRN cardinality (>1 FRN
					// identifier) must already be visible in `identifiers` at both query points; only the two
					// form-499 filing edges below vary between "still open" and "closed" across the two asOf values.
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
					// FRN_IN_FORCE: filed EARLIER, but STILL IN FORCE (valid_to null) at every asOf used below.
					authoritativeEdge({
						from_node_id: FRN_IN_FORCE,
						to_node_id: FORM_IN_FORCE,
						source: "form-499",
						source_vintage: "2026-02-01",
						valid_from: "2026-02-01",
					}),
					// FRN_CLOSED: filed LATER, but superseded/CLOSED (valid_to set) before the "after closing" asOf.
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

		it("BEFORE the closing date, the later-filed (then still-open) FRN correctly wins — proving the temporal window, not a static preference, gates the outcome", async () => {
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
		/**
		 * Closes gate 4's own fixture blindness (review fix, CRITICAL): every OTHER gate-4 fixture above hand-writes ISO
		 * `valid_from` directly into `filer_edge`, so none of them could ever catch a builder that writes a NON-ISO vintage
		 * LABEL into `valid_from` — exactly what `buildFilerDatabase` did pre-fix for provider-list edges
		 * (`source_vintage`/`valid_from` both took `options.sourceVintage` verbatim). This test goes through the REAL
		 * builder instead, with `sourceVintage: "2026-Q2"` — the realistic provider-list vintage shape
		 * `cluster-filers.ts`'s own module docstring names, and the exact shape 20 of this branch's pre-fix tests passed
		 * under — plus a SEPARATE, always-ISO `validFrom`. If the ISO guard (or the sourceVintage/validFrom split) is ever
		 * reverted, `valid_from` reverts to the literal string `"2026-Q2"`, which sorts LEXICOGRAPHICALLY ABOVE
		 * `"2026-12-31"` (`"Q"` > any ASCII digit) — the `asOf`-scoped read below would then silently exclude the edge, and
		 * this test would fail.
		 */
		it("REAL builder path: a non-ISO sourceVintage never leaks into valid_from — a provider-list edge built via buildFilerDatabase stays findable asOf a real date", async () => {
			await withScratchDir(async (out) => {
				await buildFilerDatabase({
					providerRows: [{ providerID: 600_001, frn: toFRN("0006000001")!, holdingCompany: "Realbuild Co" }],
					out,
					sourceVintage: "2026-Q2",
					validFrom: "2026-06-30",
					buildSHA: "deadbeef",
				})

				using db = openFilerDB(out)

				const result = await filerLookup(db, { bdcProviderID: 600_001, asOf: "2026-12-31" })

				// Plain loop, not .filter().map() — keeps this callback within max-nested-callbacks under
				// withScratchDir's own async closure.
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

				// Task 3 fix round 1, CRITICAL: identifiers is relationship: same_entity ONLY now — a
				// HoldingCompanyName never surfaces here regardless of how findable its edge is asOf this date.
				expect(holdingValues).toEqual([])

				// The holding-company relationship itself is STILL correctly asOf-scoped (this test's whole point —
				// the non-ISO sourceVintage never leaking into valid_from) — just surfaced via `families`, not
				// `identifiers`, now that the two rollups are kept apart.
				expect(result.families).toHaveLength(1)
				expect(result.families[0]?.relationship).toBe(FilerRelationship.HoldingCompany)
				expect(result.families[0]?.family_id.startsWith(`${FilerIdentifierType.HoldingCompanyName}:`)).toBe(true)
			})
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

/**
 * The two §7-3b gates Task 3 discharges (Task 8 extends both to EDGAR-sourced families — out of scope here). See
 * `docs/superpowers/plans/2026-07-31-filer-3b-plan.md`'s "Acceptance gates (§7-3b…)" section for the gates verbatim,
 * and `task-3-brief.md` for the per-gate implementation notes.
 */
describe("§7-3b gates", () => {
	describe("1. Family and entity cluster are never conflated (load-bearing)", () => {
		/**
		 * STRUCTURAL half: {@link FilerLookupCluster} (`cluster_id`/`members`) and {@link FilerLookupFamily}
		 * (`family_id`/`relationship`) are shapes with NO field in common — assigning one to a variable typed as the other
		 * is a compile error (`@ts-expect-error` below asserts exactly that). Only `tsc` (`yarn typecheck:tests`) checks
		 * this — `yarn vitest run` alone (esbuild, types stripped) skips the `@ts-expect-error` line entirely, so the
		 * RUNTIME half in the next test is what actually fails if the two rollups ever get folded together.
		 */
		it("FilerLookupCluster and FilerLookupFamily are structurally incompatible types", () => {
			const clusterShaped: FilerLookupCluster = { cluster_id: "authoritative:x", members: ["a", "b"] }

			// @ts-expect-error — a cluster-shaped value (cluster_id/members) must not satisfy the family shape
			// (family_id/relationship): the two rollups are never structurally interchangeable.
			const misassigned: FilerLookupFamily = clusterShaped

			expect(misassigned).toBe(clusterShaped)
		})

		/**
		 * RUNTIME half, mutation-provable: FRN_CLUSTER_A and FRN_CLUSTER_B share an authoritative entity cluster (same
		 * filer, two identifiers). FRN_CLUSTER_A is ALSO a member of a corporate family alongside FRN_FAMILY_ONLY — a
		 * completely different filer that shares nothing with FRN_CLUSTER_B. If a future edit ever folds family membership
		 * into `cluster` (e.g. widening `deriveClusterMembersAsOf`'s reachability to also walk `filer_family`),
		 * FRN_FAMILY_ONLY would leak into `resultA.cluster.members` and this test dies. If a future edit ever folds cluster
		 * membership into `families` (e.g. deriving family rows from `filer_cluster`), FRN_CLUSTER_B would leak into
		 * `resultA.families` (or a spurious cluster-shaped entry would appear) and this test dies too. Both directions are
		 * covered by one fixture.
		 */
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

			// Entity cluster: A and B are the SAME filer under two identifiers — an authoritative edge plus a
			// filer_cluster snapshot, exactly as cluster-filers.ts would leave it.
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

			// Corporate family: A and FAMILY_ONLY share a holding company — a DIFFERENT filer, never part of A's
			// entity cluster.
			await db
				.insertInto("filer_family")
				.values([
					{
						node_id: FRN_CLUSTER_A,
						family_id: "holding_company_name:bigco-inc",
						relationship: FilerRelationship.HoldingCompany,
						source: "form-499",
						source_vintage: "2026-01-01",
						valid_from: "2026-01-01",
						valid_to: null,
					},
					{
						node_id: FRN_FAMILY_ONLY,
						family_id: "holding_company_name:bigco-inc",
						relationship: FilerRelationship.HoldingCompany,
						source: "form-499",
						source_vintage: "2026-01-01",
						valid_from: "2026-01-01",
						valid_to: null,
					},
				])
				.execute()

			const resultA = await filerLookup(db, { frn: toFRN("1010101010")!, asOf: "2026-06-01" })

			// GATE 1: cluster stays EXACTLY {A, B} — the family-only mate never leaks in.
			expect(resultA.cluster).toEqual({ cluster_id: "authoritative:AB", members: [FRN_CLUSTER_A, FRN_CLUSTER_B] })

			// GATE 1: families stays EXACTLY the one family fact — no cluster-shaped data leaks in, and B (a cluster
			// mate with no family row of its own) never appears here. display_names is [] here because this fixture
			// never writes a matching filer_edge for the family row (that join is covered by its own dedicated tests
			// below and in family-rollup.test.ts) — gate 1 itself is only about structural disjointness.
			expect(resultA.families).toEqual([
				{
					family_id: "holding_company_name:bigco-inc",
					relationship: FilerRelationship.HoldingCompany,
					display_names: [],
				},
			])

			// Symmetric check from B's side: B is in the SAME cluster as A, but carries no family membership of its
			// own — families must be empty, never inheriting A's family fact via the shared cluster.
			const resultB = await filerLookup(db, { frn: toFRN("2020202020")!, asOf: "2026-06-01" })
			expect(resultB.cluster).toEqual({ cluster_id: "authoritative:AB", members: [FRN_CLUSTER_A, FRN_CLUSTER_B] })
			expect(resultB.families).toEqual([])

			// Symmetric check from FAMILY_ONLY's side: shares A's family, but has no authoritative edge/cluster
			// assignment at all — cluster must be null, never inheriting A's cluster via the shared family.
			const resultFamilyOnly = await filerLookup(db, { frn: toFRN("3030303030")!, asOf: "2026-06-01" })
			expect(resultFamilyOnly.cluster).toBeNull()

			expect(resultFamilyOnly.families).toEqual([
				{
					family_id: "holding_company_name:bigco-inc",
					relationship: FilerRelationship.HoldingCompany,
					display_names: [],
				},
			])
		})

		/**
		 * THE REAL GATE (task 3 fix round 1 — re-cut per the reviewer's finding). The test above hand-writes
		 * `filer_cluster`/`filer_family` directly and never calls the real builder or clusterer — it proves `filerLookup`'s
		 * OWN queries stay disjoint, but it CANNOT catch a builder or clusterer that emits the underlying rows differently.
		 * That is exactly what happened: `cluster-filers.ts`'s `readAuthoritativeGroups` union-found every `assertion:
		 * "authoritative"` edge with no `relationship` filter, so real `HoldingCompany` edges (correctly authoritative, per
		 * Task 2) silently merged every filer sharing a holding company into ONE entity cluster — three unrelated filers
		 * reported as one. This test goes through the REAL pipeline end to end: `buildFilerDatabase` (writes typed edges +
		 * family membership) then `clusterAuthoritativeComponents` (writes `filer_cluster`) then
		 * `filerLookup`/`familyRollup` (reads both). Three FRNs sharing one holding company MUST yield THREE distinct
		 * entity clusters (never merged) and ONE shared family — the mutation this closes (deleting the `relationship`
		 * filter from `readAuthoritativeGroups`) collapses the three clusters back into one and fails this test
		 * immediately.
		 */
		it("REAL builder + REAL clusterAuthoritativeComponents: 3 FRNs sharing one holding company yield 3 distinct entity clusters and 1 shared family — never merged", async () => {
			await withScratchDir(async (out) => {
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

				// buildFilerDatabase seals the artifact read-only (core/utils/sealed-db.ts) — clusterAuthoritativeComponents
				// writes filer_cluster, so this unseals it first, the same as a real incremental-clustering pass would.
				chmodSync(out, 0o644)
				using db = new DatabaseClient<FilerDatabase>({ database: new DatabaseSync(out) })

				await clusterAuthoritativeComponents(db)

				// Plain loop, not .map() — keeps this callback within max-nested-callbacks under withScratchDir's own
				// async closure (the same discipline the "REAL builder path" gate-4 test above already follows).
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

				// THE GATE: 3 distinct cluster_ids — never one shared cluster_id across the 3 FRNs.
				expect(distinctClusterIDs.size).toBe(3)

				const asOf = "2026-12-31"

				const result1 = await filerLookup(db, { frn: FRN_1, asOf })
				const result2 = await filerLookup(db, { frn: FRN_2, asOf })
				const result3 = await filerLookup(db, { frn: FRN_3, asOf })

				// Each FRN's own entity cluster is just itself + its own form499ID — never any of the other two FRNs.
				expect(result1.cluster?.members).not.toContain(`${FilerIdentifierType.FRN}:${FRN_2}`)
				expect(result1.cluster?.members).not.toContain(`${FilerIdentifierType.FRN}:${FRN_3}`)
				expect(result2.cluster?.members).not.toContain(`${FilerIdentifierType.FRN}:${FRN_1}`)
				expect(result2.cluster?.members).not.toContain(`${FilerIdentifierType.FRN}:${FRN_3}`)
				expect(result3.cluster?.members).not.toContain(`${FilerIdentifierType.FRN}:${FRN_1}`)
				expect(result3.cluster?.members).not.toContain(`${FilerIdentifierType.FRN}:${FRN_2}`)

				expect(result1.cluster?.cluster_id).not.toBe(result2.cluster?.cluster_id)
				expect(result1.cluster?.cluster_id).not.toBe(result3.cluster?.cluster_id)
				expect(result2.cluster?.cluster_id).not.toBe(result3.cluster?.cluster_id)

				// All 3 share exactly ONE family, via BOTH the filerLookup.families surface and familyRollup itself.
				expect(result1.families).toHaveLength(1)
				expect(result2.families).toHaveLength(1)
				expect(result3.families).toHaveLength(1)

				const sharedFamilyID = result1.families[0]?.family_id

				expect(result2.families[0]?.family_id).toBe(sharedFamilyID)
				expect(result3.families[0]?.family_id).toBe(sharedFamilyID)

				// Task 3 fix round 2, single-spelling case: all 3 filers reported the IDENTICAL raw spelling
				// (SHARED_HOLDING), so display_names carries exactly that one value, everywhere it's surfaced.
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
		})

		/**
		 * Task 3 fix round 2, multi-spelling case (real builder, real canonicalizeOrganizationName — the reader-only unit
		 * tests for this live in family-rollup.test.ts's own `describe("display_names")` block). "Acme Corp" and "Acme
		 * Corporation, LLC" both reduce to the canonical `"acme"` (`@mailwoman/record`'s `canonicalizeOrganizationName` —
		 * `record/organization.test.ts` pins this exact collapse), so two REAL 499 rows filed under those two different
		 * spellings land in the SAME family_id. THE RULE this proves end to end: both raw spellings survive in
		 * `display_names`, sorted, never silently collapsed to one.
		 */
		it("REAL builder, multi-spelling family: two raw holding-company spellings that canonicalize identically both survive in display_names, sorted — never collapsed to one", async () => {
			await withScratchDir(async (out) => {
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

				// Same family_id — proves the two spellings really did canonicalize together, not a coincidence of
				// the fixture.
				const sharedFamilyID = result1.families[0]?.family_id
				expect(result2.families[0]?.family_id).toBe(sharedFamilyID)

				const expectedSpellings = ["Acme Corp", "Acme Corporation, LLC"].toSorted()

				// THE RULE: both spellings, sorted, on every surface that reports them.
				expect(result1.families[0]?.display_names).toEqual(expectedSpellings)
				expect(result2.families[0]?.display_names).toEqual(expectedSpellings)

				const rollup = await familyRollup(db, { familyID: sharedFamilyID!, asOf: "2026-12-31" })
				expect(rollup[0]?.display_names).toEqual(expectedSpellings)
			})
		})

		/**
		 * Task 3 fix round 3, CRITICAL — the exact failure class this phase keeps re-discovering. `readFamilyDisplayNames`
		 * used to join on `(from_node_id, relationship, source, valid_from)` WITHOUT `to_node_id`: when one node carries
		 * TWO holding-company edges sharing that 4-tuple (the documented decision-6 shape —
		 * `ProviderListRow.holdingCompany`'s own docstring: "one providerID can legitimately carry different holdingCompany
		 * strings across rows"), every name matching the tuple leaked into EVERY family_id the node happened to touch, not
		 * just the one each edge actually names. That is a FALSE RELATIONSHIP CLAIM — a family reporting a holding company
		 * it never reported — reproduced here end to end on BOTH shapes the reviewer found: the provider-list path (one
		 * providerID, two holdingCompany values, one shared file-level validFrom) and the 499 path (one FRN, two rows, the
		 * identical lastFiledAt).
		 */
		it("display_names never leaks across a DIFFERENT family: REAL builder, provider-list path — one providerID with two DIFFERENT holding companies under the same source+valid_from never cross-contaminates each family's display_names", async () => {
			await withScratchDir(async (out) => {
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

				// Plain loop, not .map(), to build the lookup — keeps this callback within max-nested-callbacks
				// under withScratchDir's own async closure.
				const familyByID = new Map<string, (typeof result.families)[number]>()

				for (const family of result.families) {
					familyByID.set(family.family_id, family)
				}

				// THE BUG (pre-fix): BOTH entries' display_names would each contain BOTH names. THE FIX: each
				// family reports ONLY the one name that actually implies it.
				expect(familyByID.get(familyIDAlpha)?.display_names).toEqual(["Alpha Holdco"])
				expect(familyByID.get(familyIDZenith)?.display_names).toEqual(["Zenith Unrelated Group"])

				const rollupAlpha = await familyRollup(db, { familyID: familyIDAlpha, asOf: "2026-12-31" })
				const rollupZenith = await familyRollup(db, { familyID: familyIDZenith, asOf: "2026-12-31" })

				expect(rollupAlpha[0]?.display_names).toEqual(["Alpha Holdco"])
				expect(rollupZenith[0]?.display_names).toEqual(["Zenith Unrelated Group"])
			})
		})

		it("display_names never leaks across a DIFFERENT family: REAL builder, 499 path — one FRN with two DIFFERENT holding companies filed the same day never cross-contaminates each family's display_names", async () => {
			await withScratchDir(async (out) => {
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
	})

	describe("2. Relationship kind + provenance mandatory on every family row", () => {
		/**
		 * STRUCTURAL half (the established idiom — see this file's own §7-3a gate 1 above): an exhaustive `satisfies
		 * Record<keyof FilerFamilyInsert, true>` pin over `filer_family`'s insert shape. `FilerFamilyTable` carries no
		 * `Generated<>`-wrapped columns (`schema.ts`), so `Insertable<FilerFamilyTable>` already requires every field on
		 * insert — this pin's job is making sure that guarantee can't silently erode: a field ADDED to `FilerFamilyTable`
		 * that this literal doesn't also list fails `satisfies`, forcing a reviewer to consciously answer "is the new field
		 * also load-bearing provenance?" Only `tsc` (`yarn typecheck:tests`) checks this.
		 */
		type FilerFamilyInsert = Insertable<FilerFamilyTable>

		const FILER_FAMILY_INSERT_FIELDS = {
			node_id: true,
			family_id: true,
			relationship: true,
			source: true,
			source_vintage: true,
			valid_from: true,
			valid_to: true,
		} satisfies Record<keyof FilerFamilyInsert, true>

		it("the structural pin enumerates every FilerFamilyTable field, including relationship/source/source_vintage/valid_from", () => {
			expect(Object.keys(FILER_FAMILY_INSERT_FIELDS)).toHaveLength(7)

			expect(FILER_FAMILY_INSERT_FIELDS).toMatchObject({
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
				family_id: "holding_company_name:gate2-co",
				// relationship deliberately omitted — this is the runtime half of gate 2's rejection test.
				source: "form-499",
				source_vintage: "2026-01-01",
				valid_from: "2026-01-01",
				valid_to: null,
			} as unknown as FilerFamilyInsert

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
				family_id: "holding_company_name:gate2-co",
				relationship: FilerRelationship.HoldingCompany,
				// source deliberately omitted
				source_vintage: "2026-01-01",
				valid_from: "2026-01-01",
				valid_to: null,
			} as unknown as FilerFamilyInsert

			await expect(db.insertInto("filer_family").values(partialFamily).execute()).rejects.toThrow(
				/NOT NULL constraint failed/
			)
		})

		it("SQLite's NOT NULL alone does NOT reject an empty-string relationship — the CHECK constraint is what closes that gap (the 3a lesson, gate 2)", async () => {
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
						family_id: "holding_company_name:gate2-co",
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
						family_id: "holding_company_name:gate2-co",
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

	/**
	 * Task 3 fix round 1, IMPORTANT-1: deleting BOTH halves of `families`'s asOf predicate in filer-lookup.ts left
	 * 529/529 tests passing — only `family-rollup.ts`'s OWN copy of the predicate was ever probed. These two tests close
	 * that blind spot directly against `filerLookup`'s `families` field.
	 */
	describe("families is asOf-scoped (task 3 fix round 1, IMPORTANT-1)", () => {
		const FRN_TEMPORAL = `${FilerIdentifierType.FRN}:4040404050`
		const FAMILY_ID_TEMPORAL = "holding_company_name:temporal-co"

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

			expect(onOrAfter.families).toEqual([
				{ family_id: FAMILY_ID_TEMPORAL, relationship: FilerRelationship.HoldingCompany, display_names: [] },
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
					relationship: FilerRelationship.HoldingCompany,
					source: "form-499",
					source_vintage: "2026-01-01",
					valid_from: "2026-01-01",
					valid_to: "2026-03-01",
				})
				.execute()

			const withinWindow = await filerLookup(db, { frn: toFRN("4040404050")!, asOf: "2026-02-01" })

			expect(withinWindow.families).toEqual([
				{ family_id: FAMILY_ID_TEMPORAL, relationship: FilerRelationship.HoldingCompany, display_names: [] },
			])

			const atClose = await filerLookup(db, { frn: toFRN("4040404050")!, asOf: "2026-03-01" })
			expect(atClose.families).toEqual([])

			const afterClose = await filerLookup(db, { frn: toFRN("4040404050")!, asOf: "2026-04-01" })
			expect(afterClose.families).toEqual([])
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
