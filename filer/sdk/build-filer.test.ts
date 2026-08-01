/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for {@linkcode buildFilerDatabase} — the stage/materialize/seal build of `filer.db` (3a Task
 *   5). Feeds the loader synthetic {@link Form499Row}/{@link ProviderListRow} sources directly (the
 *   `form499Rows`/`providerRows` seams), so the suite exercises the whole build WITHOUT touching the
 *   filesystem — matches `build-bdc.test.ts`'s injected-row convention.
 */

import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { describe, expect, it } from "vitest"

import {
	FilerEdgeAssertion,
	FilerIdentifierType,
	FilerRelationship,
	readFilerManifest,
	type FilerDatabase,
} from "../schema.ts"
import { buildFilerDatabase, type BuildFilerResult, type EdgarSubsidiaryRow } from "./build-filer.ts"
import type { Form499Row } from "./form499.ts"
import { toFRN } from "./frn.ts"
import type { ProviderListRow } from "./provider-list.ts"

const FRN_ACME = toFRN("0001753557")!
const FRN_BDC_ONLY = toFRN("0009999999")!
const FRN_GAMMA = toFRN("0005555555")!

// 3b Task 2 family-membership fixtures — distinct from the FRNs above to avoid any accidental cross-test coupling.
const FRN_DELTA = toFRN("0002222222")!
const FRN_EPSILON = toFRN("0003333333")!
const FRN_ZETA = toFRN("0004444444")!

/**
 * Row A: a fully-populated 499 filing — FRN present, both company fields present, every attribute-bearing field
 * populated. Row B: an unregistered filer (no FRN — legitimate per decision 3, NOT malformed) with most optional fields
 * blank.
 */
function form499FixtureRows(): Form499Row[] {
	return [
		{
			form499ID: "899901",
			frn: FRN_ACME,
			lastFiledAt: "2026-01-15",
			usfContributor: true,
			legalNameOfCarrier: "Acme Telecom LLC",
			doingBusinessAs: "Acme Fiber",
			principalCommType: "Incumbent Local Exchange Carrier",
			holdingCompany: "Acme Holdings Inc",
			managementCompany: "Acme Management Co",
			hqAddress: "123 Main St",
			customerInquiriesTelephone: "555-1000",
			customerInquiriesAddress: "123 Main St",
			dcAgentDisplayName: "John Doe",
			dcAgentOrganizationName: "CT Corporation",
			dcAgentTelephone: "555-2000",
			dcAgentEmailAddress: "agent@ctcorp.com",
			dcAgentAddress: "456 Agent Ave",
		},
		{
			form499ID: "899902",
			frn: null,
			lastFiledAt: "2026-02-01",
			usfContributor: false,
			legalNameOfCarrier: "Beta Networks",
			doingBusinessAs: "",
			principalCommType: "CLEC",
			holdingCompany: "",
			managementCompany: "",
			hqAddress: "789 Beta Blvd",
			customerInquiriesTelephone: "",
			customerInquiriesAddress: "",
			dcAgentDisplayName: "",
			dcAgentOrganizationName: "",
			dcAgentTelephone: "",
			dcAgentEmailAddress: "",
			dcAgentAddress: "",
		},
	]
}

/**
 * `providerID` 130077 carries TWO rows with different FRNs (decision 6 cardinality — must survive as two distinct
 * edges, never folded/last-wins). Row 2's `holdingCompany` is `null` (legitimate — must be counted as `skipped`, never
 * thrown). `providerID` 130080 is a second, independent provider.
 */
function providerFixtureRows(): ProviderListRow[] {
	return [
		{ providerID: 130_077, frn: FRN_ACME, holdingCompany: "Acme Holdings Inc" },
		{ providerID: 130_077, frn: FRN_BDC_ONLY, holdingCompany: null },
		{ providerID: 130_080, frn: FRN_GAMMA, holdingCompany: "Gamma Corp" },
	]
}

let scratch: string
let out: string

async function setupScratch(): Promise<void> {
	scratch = await mkdtemp(join(tmpdir(), "filer-build-"))
	out = join(scratch, "filer.db")
}

async function teardownScratch(): Promise<void> {
	await rm(scratch, { recursive: true, force: true })
}

function openFilerDB(path: string): DatabaseClient<FilerDatabase> {
	return new DatabaseClient<FilerDatabase>({ database: new DatabaseSync(path, { readOnly: true }) })
}

describe("buildFilerDatabase", () => {
	it("builds a sealed file at `out`", async () => {
		await setupScratch()

		try {
			await buildFilerDatabase({
				form499Rows: form499FixtureRows(),
				providerRows: providerFixtureRows(),
				out,
				sourceVintage: "2026-Q1",
				validFrom: "2026-01-31",
				buildSHA: "deadbeef",
			})

			expect(existsSync(out)).toBe(true)
			expect(existsSync(`${out}.building`)).toBe(false)
			expect(existsSync(`${out}.prev`)).toBe(false)
		} finally {
			await teardownScratch()
		}
	})

	it("emits FRN↔form499ID, FRN↔holdingCompanyName, and FRN↔managementCompanyName (both) for a filed 499 row", async () => {
		await setupScratch()

		try {
			await buildFilerDatabase({
				form499Rows: form499FixtureRows(),
				out,
				sourceVintage: "2026-Q1",
				buildSHA: "deadbeef",
			})

			using db = openFilerDB(out)
			const frnNodeID = `${FilerIdentifierType.FRN}:${FRN_ACME}`

			const edges = await db.selectFrom("filer_edge").selectAll().where("from_node_id", "=", frnNodeID).execute()
			const toIDs = edges.map((e) => e.to_node_id).toSorted()

			expect(toIDs).toEqual(
				[
					`${FilerIdentifierType.Form499ID}:899901`,
					`${FilerIdentifierType.HoldingCompanyName}:Acme Holdings Inc`,
					`${FilerIdentifierType.ManagementCompanyName}:Acme Management Co`,
				].toSorted()
			)

			for (const edge of edges) {
				expect(edge.source).toBe("form-499")
				expect(edge.source_vintage).toBe("2026-01-15")
				expect(edge.valid_from).toBe("2026-01-15")
				expect(edge.assertion).toBe("authoritative")
			}
		} finally {
			await teardownScratch()
		}
	})

	it("records a 499 row with no FRN as a form499ID node with attributes, never throwing", async () => {
		await setupScratch()

		try {
			await buildFilerDatabase({
				form499Rows: form499FixtureRows(),
				out,
				sourceVintage: "2026-Q1",
				buildSHA: "deadbeef",
			})

			using db = openFilerDB(out)

			const node = await db
				.selectFrom("filer_node")
				.selectAll()
				.where("node_id", "=", `${FilerIdentifierType.Form499ID}:899902`)
				.executeTakeFirst()

			expect(node).toBeDefined()

			const legalName = await db
				.selectFrom("filer_attribute")
				.selectAll()
				.where("node_id", "=", `${FilerIdentifierType.Form499ID}:899902`)
				.where("key", "=", "legal_name")
				.executeTakeFirstOrThrow()

			expect(legalName.value).toBe("Beta Networks")

			const classification = await db
				.selectFrom("filer_attribute")
				.selectAll()
				.where("node_id", "=", `${FilerIdentifierType.Form499ID}:899902`)
				.where("key", "=", "classification")
				.executeTakeFirstOrThrow()

			expect(classification.value).toBe("clec")
		} finally {
			await teardownScratch()
		}
	})

	it("a bdcProviderID with two FRNs yields two distinct bdcProviderID↔FRN edges (decision 6)", async () => {
		await setupScratch()

		try {
			await buildFilerDatabase({
				providerRows: providerFixtureRows(),
				out,
				sourceVintage: "2026-06-30",
				validFrom: "2026-06-30",
				buildSHA: "deadbeef",
			})

			using db = openFilerDB(out)
			const providerNodeID = `${FilerIdentifierType.BDCProviderID}:130077`

			const frnEdges = await db
				.selectFrom("filer_edge")
				.selectAll()
				.where("from_node_id", "=", providerNodeID)
				.where("to_node_id", "like", `${FilerIdentifierType.FRN}:%`)
				.execute()

			expect(frnEdges).toHaveLength(2)

			expect(frnEdges.map((e) => e.to_node_id).toSorted()).toEqual(
				[`${FilerIdentifierType.FRN}:${FRN_ACME}`, `${FilerIdentifierType.FRN}:${FRN_BDC_ONLY}`].toSorted()
			)
		} finally {
			await teardownScratch()
		}
	})

	it("emits bdcProviderID↔holdingCompanyName only when holdingCompany is present, counting the rest as skipped", async () => {
		await setupScratch()

		try {
			const result = await buildFilerDatabase({
				providerRows: providerFixtureRows(),
				out,
				sourceVintage: "2026-06-30",
				validFrom: "2026-06-30",
				buildSHA: "deadbeef",
			})

			// Row 2 (providerID 130077, frn FRN_BDC_ONLY) has holdingCompany: null — no edge, counted as skipped.
			expect(result.skipped).toBe(1)

			using db = openFilerDB(out)

			const holdingEdges = await db
				.selectFrom("filer_edge")
				.selectAll()
				.where("to_node_id", "like", `${FilerIdentifierType.HoldingCompanyName}:%`)
				.execute()

			// Only providerID 130077 (row 1, Acme Holdings Inc) and providerID 130080 (Gamma Corp).
			expect(holdingEdges).toHaveLength(2)
		} finally {
			await teardownScratch()
		}
	})

	it("every edge carries non-empty provenance (source, source_vintage, assertion, valid_from), and valid_from is always ISO YYYY-MM-DD even when sourceVintage is a non-ISO label", async () => {
		await setupScratch()

		try {
			await buildFilerDatabase({
				form499Rows: form499FixtureRows(),
				providerRows: providerFixtureRows(),
				out,
				sourceVintage: "2026-Q1",
				validFrom: "2026-01-31",
				buildSHA: "deadbeef",
			})

			using db = openFilerDB(out)
			const edges = await db.selectFrom("filer_edge").selectAll().execute()

			expect(edges.length).toBeGreaterThan(0)

			for (const edge of edges) {
				expect(edge.source.length).toBeGreaterThan(0)
				expect(edge.source_vintage.length).toBeGreaterThan(0)
				expect(edge.assertion).toBe("authoritative")
				expect(edge.valid_from.length).toBeGreaterThan(0)
				// sourceVintage above ("2026-Q1") is deliberately NOT ISO — valid_from must never inherit that shape
				// (review fix, CRITICAL): every edge's valid_from is ISO YYYY-MM-DD regardless of source.
				expect(edge.valid_from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
			}
		} finally {
			await teardownScratch()
		}
	})

	it("never emits an edge derived from a DC-agent field", async () => {
		await setupScratch()

		try {
			await buildFilerDatabase({
				form499Rows: form499FixtureRows(),
				out,
				sourceVintage: "2026-Q1",
				buildSHA: "deadbeef",
			})

			using db = openFilerDB(out)
			const edges = await db.selectFrom("filer_edge").selectAll().execute()

			for (const edge of edges) {
				expect(edge.from_node_id).not.toContain("CT Corporation")
				expect(edge.to_node_id).not.toContain("CT Corporation")
				expect(edge.from_node_id).not.toContain("John Doe")
				expect(edge.to_node_id).not.toContain("John Doe")
			}

			// DC-agent fields still recorded — but ONLY as plain attributes, never as relationship evidence.
			const dcAgentAttr = await db
				.selectFrom("filer_attribute")
				.selectAll()
				.where("key", "=", "dc_agent_organization_name")
				.executeTakeFirstOrThrow()

			expect(dcAgentAttr.value).toBe("CT Corporation")
		} finally {
			await teardownScratch()
		}
	})

	it("the manifest carries the build's source vintage and the sources actually used", async () => {
		await setupScratch()

		try {
			await buildFilerDatabase({
				form499Rows: form499FixtureRows(),
				providerRows: providerFixtureRows(),
				out,
				sourceVintage: "2026-Q1",
				validFrom: "2026-01-31",
				buildSHA: "cafebabe",
			})

			using db = openFilerDB(out)
			const manifest = await readFilerManifest(db)

			expect(manifest.name).toBe("filer")
			expect(manifest.source_vintage).toBe("2026-Q1")
			expect(manifest.version).toBe("2026-Q1")
			expect(manifest.build_sha).toBe("cafebabe")
			expect(manifest.source).toBe("form-499,bdc-provider-list")
		} finally {
			await teardownScratch()
		}
	})

	it("the manifest's source lists only the sources actually supplied", async () => {
		await setupScratch()

		try {
			await buildFilerDatabase({
				providerRows: providerFixtureRows(),
				out,
				sourceVintage: "2026-Q1",
				validFrom: "2026-01-31",
				buildSHA: "cafebabe",
			})

			using db = openFilerDB(out)
			const manifest = await readFilerManifest(db)

			expect(manifest.source).toBe("bdc-provider-list")
		} finally {
			await teardownScratch()
		}
	})

	it("a malformed row (empty form499ID) is loud, and no artifact is left behind", async () => {
		await setupScratch()

		try {
			const malformedRows: Form499Row[] = [
				{
					...form499FixtureRows()[0]!,
					form499ID: "",
				},
			]

			await expect(
				buildFilerDatabase({
					form499Rows: malformedRows,
					out,
					sourceVintage: "2026-Q1",
					buildSHA: "deadbeef",
				})
			).rejects.toThrow(/malformed.*form499ID/i)

			expect(existsSync(out)).toBe(false)
		} finally {
			await teardownScratch()
		}
	})

	it("an empty lastFiledAt is loud — never produces a blank-provenance edge (decision 7 / gate 1, fix round 1)", async () => {
		await setupScratch()

		try {
			const malformedRows: Form499Row[] = [
				{
					...form499FixtureRows()[0]!,
					lastFiledAt: "",
				},
			]

			await expect(
				buildFilerDatabase({
					form499Rows: malformedRows,
					out,
					sourceVintage: "2026-Q1",
					buildSHA: "deadbeef",
				})
			).rejects.toThrow(/malformed.*lastFiledAt/i)

			expect(existsSync(out)).toBe(false)
		} finally {
			await teardownScratch()
		}
	})

	it("a blank provider-list frn is loud — never mints a shared degenerate FRN node (fix round 1)", async () => {
		await setupScratch()

		try {
			const malformedRows: ProviderListRow[] = [
				// Two DIFFERENT, unrelated providers, both with a blank frn — without the guard these would
				// silently share ONE degenerate `frn:` node, falsely asserting they are the same filer.
				{ providerID: 900_001, frn: "" as ProviderListRow["frn"], holdingCompany: null },
				{ providerID: 900_002, frn: "" as ProviderListRow["frn"], holdingCompany: null },
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
		} finally {
			await teardownScratch()
		}
	})

	it("throws when neither a 499 nor a provider-list source is supplied", async () => {
		await setupScratch()

		try {
			await expect(
				buildFilerDatabase({
					out,
					sourceVintage: "2026-Q1",
					buildSHA: "deadbeef",
				})
			).rejects.toThrow(/pass at least one/)
		} finally {
			await teardownScratch()
		}
	})

	describe("idempotent write path (carried from Task 4's review)", () => {
		/**
		 * A single fully-populated row, deliberately small so every count below is hand-verifiable: 3 nodes (form499ID,
		 * FRN, holdingCompanyName — managementCompany is blank, so NO management-company node/edge), 2 edges
		 * (FRN↔form499ID, FRN↔holdingCompanyName), 2 attributes (legal_name, classification), 1 skip (the blank
		 * managementCompany).
		 */
		function idempotencyFixtureRow(): Form499Row {
			return {
				form499ID: "700001",
				frn: toFRN("0001111111")!,
				lastFiledAt: "2026-03-01",
				usfContributor: true,
				legalNameOfCarrier: "Idem Co",
				doingBusinessAs: "",
				principalCommType: "",
				holdingCompany: "Idem Holdings",
				managementCompany: "",
				hqAddress: "",
				customerInquiriesTelephone: "",
				customerInquiriesAddress: "",
				dcAgentDisplayName: "",
				dcAgentOrganizationName: "",
				dcAgentTelephone: "",
				dcAgentEmailAddress: "",
				dcAgentAddress: "",
			}
		}

		it("collapses a same-source/same-vintage duplicate row within one build (filer_attribute has no PK of its own)", async () => {
			await setupScratch()

			try {
				const row = idempotencyFixtureRow()

				// The SAME row twice — simulates a same-source/same-vintage double-insert opportunity.
				const result = await buildFilerDatabase({
					form499Rows: [row, row],
					out,
					sourceVintage: "2026-Q1",
					buildSHA: "deadbeef",
				})

				expect(result.nodes).toBe(3)
				expect(result.edges).toBe(2)
				expect(result.attributes).toBe(2)
				expect(result.skipped).toBe(2)

				using db = openFilerDB(out)
				const nodeCount = await db.selectFrom("filer_node").select(db.fn.countAll().as("c")).executeTakeFirstOrThrow()
				const edgeCount = await db.selectFrom("filer_edge").select(db.fn.countAll().as("c")).executeTakeFirstOrThrow()

				const attrCount = await db
					.selectFrom("filer_attribute")
					.select(db.fn.countAll().as("c"))
					.executeTakeFirstOrThrow()

				expect(Number(nodeCount.c)).toBe(3)
				expect(Number(edgeCount.c)).toBe(2)
				expect(Number(attrCount.c)).toBe(2)
			} finally {
				await teardownScratch()
			}
		})

		it("re-running the same build inputs against the same `out` does not grow row counts", async () => {
			await setupScratch()

			try {
				const row = idempotencyFixtureRow()

				const first: BuildFilerResult = await buildFilerDatabase({
					form499Rows: [row, row],
					out,
					sourceVintage: "2026-Q1",
					buildSHA: "deadbeef",
				})

				const second: BuildFilerResult = await buildFilerDatabase({
					form499Rows: [row, row],
					out,
					sourceVintage: "2026-Q1",
					buildSHA: "deadbeef",
				})

				expect(second.nodes).toBe(first.nodes)
				expect(second.edges).toBe(first.edges)
				expect(second.attributes).toBe(first.attributes)
				expect(second.skipped).toBe(first.skipped)

				expect(first.nodes).toBe(3)
				expect(first.edges).toBe(2)
				expect(first.attributes).toBe(2)

				// The rebuild-and-swap discipline: no `.prev` left lingering.
				expect(existsSync(`${out}.prev`)).toBe(false)
			} finally {
				await teardownScratch()
			}
		})

		it("two DIFFERENT classification values under the same key/source/vintage both survive (not collapsed by the stage PK)", async () => {
			await setupScratch()

			try {
				// usfContributor: true + an Incumbent principalCommType -> two classification values
				// ("usf_contributor", "incumbent_lec") sharing (node_id, key="classification", source, source_vintage) —
				// only `value` differs. Proves the stage table's dedup key includes `value`, not just
				// (node_id, key, source, source_vintage), or the second classification would be silently dropped.
				const row: Form499Row = {
					...idempotencyFixtureRow(),
					principalCommType: "Incumbent Local Exchange Carrier",
				}

				await buildFilerDatabase({
					form499Rows: [row],
					out,
					sourceVintage: "2026-Q1",
					buildSHA: "deadbeef",
				})

				using db = openFilerDB(out)

				const classifications = await db
					.selectFrom("filer_attribute")
					.selectAll()
					.where("node_id", "=", `${FilerIdentifierType.Form499ID}:700001`)
					.where("key", "=", "classification")
					.execute()

				expect(classifications.map((c) => c.value).toSorted()).toEqual(["incumbent_lec", "usf_contributor"])
			} finally {
				await teardownScratch()
			}
		})
	})

	describe("single-vintage snapshot semantics (review MINOR-B, fix round 1)", () => {
		it("rebuilding at a later sourceVintage REPLACES the artifact — earlier-vintage rows do not survive", async () => {
			await setupScratch()

			try {
				await buildFilerDatabase({
					providerRows: [{ providerID: 500_001, frn: toFRN("0007777777")!, holdingCompany: "Old Co" }],
					out,
					sourceVintage: "2026-Q1",
					validFrom: "2026-01-31",
					buildSHA: "deadbeef",
				})

				await buildFilerDatabase({
					providerRows: [{ providerID: 500_002, frn: toFRN("0008888888")!, holdingCompany: "New Co" }],
					out,
					sourceVintage: "2026-Q2",
					validFrom: "2026-04-30",
					buildSHA: "deadbeef",
				})

				using db = openFilerDB(out)
				const edges = await db.selectFrom("filer_edge").selectAll().execute()

				// Every edge belongs to the SECOND build's vintage — none of the first build's rows survived
				// alongside it as additional rows (that would be cross-build accumulation, which this artifact
				// deliberately does not support — see the module docstring's MINOR-B note).
				expect(edges.length).toBeGreaterThan(0)
				expect(edges.every((e) => e.source_vintage === "2026-Q2")).toBe(true)

				const providerNodeIDs = (await db.selectFrom("filer_node").selectAll().execute()).map((n) => n.node_id)
				expect(providerNodeIDs).not.toContain(`${FilerIdentifierType.BDCProviderID}:500001`)
				expect(providerNodeIDs).toContain(`${FilerIdentifierType.BDCProviderID}:500002`)

				const manifest = await readFilerManifest(db)
				expect(manifest.source_vintage).toBe("2026-Q2")
			} finally {
				await teardownScratch()
			}
		})
	})

	describe("typed relationship + family membership (3b Task 2)", () => {
		const SOURCE_VINTAGE = "2026-Q3"

		/**
		 * A minimal, fully-blank Form499Row overridden per test — keeps each fixture below down to just the fields that
		 * matter for what it's testing, matching `idempotencyFixtureRow`'s intent one describe block up.
		 */
		function familyFixtureRow(overrides: Partial<Form499Row> & Pick<Form499Row, "form499ID" | "frn">): Form499Row {
			return {
				lastFiledAt: "2026-05-01",
				usfContributor: false,
				legalNameOfCarrier: `Carrier ${overrides.form499ID}`,
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

		it("types holding/management edges to their named FilerRelationship, keeping identity edges SameEntity", async () => {
			await setupScratch()

			try {
				const row = familyFixtureRow({
					form499ID: "800001",
					frn: FRN_DELTA,
					holdingCompany: "Alpha Holdco Inc",
					managementCompany: "Beta Management Co",
				})

				await buildFilerDatabase({
					form499Rows: [row],
					providerRows: [{ providerID: 210_001, frn: FRN_DELTA, holdingCompany: "Alpha Holdco Inc" }],
					out,
					sourceVintage: SOURCE_VINTAGE,
					validFrom: "2026-05-01",
					buildSHA: "deadbeef",
				})

				using db = openFilerDB(out)
				const edges = await db.selectFrom("filer_edge").selectAll().execute()

				const toTarget = (nodeID: string) => edges.filter((e) => e.to_node_id === nodeID)

				// FRN<->form499ID: identity, never HoldingCompany/ManagementCompany.
				expect(
					toTarget(`${FilerIdentifierType.Form499ID}:800001`).every(
						(e) => e.relationship === FilerRelationship.SameEntity
					)
				).toBe(true)

				// bdcProviderID<->FRN: identity too.
				expect(
					toTarget(`${FilerIdentifierType.FRN}:${FRN_DELTA}`).every(
						(e) => e.relationship === FilerRelationship.SameEntity
					)
				).toBe(true)

				// FRN->holdingCompanyName AND bdcProviderID->holdingCompanyName both assert HoldingCompany.
				const holdingEdges = toTarget(`${FilerIdentifierType.HoldingCompanyName}:Alpha Holdco Inc`)
				expect(holdingEdges).toHaveLength(2)
				expect(holdingEdges.every((e) => e.relationship === FilerRelationship.HoldingCompany)).toBe(true)

				// FRN->managementCompanyName asserts ManagementCompany, never collapsed into HoldingCompany.
				const managementEdges = toTarget(`${FilerIdentifierType.ManagementCompanyName}:Beta Management Co`)
				expect(managementEdges).toHaveLength(1)
				expect(managementEdges[0]!.relationship).toBe(FilerRelationship.ManagementCompany)
			} finally {
				await teardownScratch()
			}
		})

		it("three distinct FRNs sharing one holding company become one family with three members", async () => {
			await setupScratch()

			try {
				const rows = [
					familyFixtureRow({ form499ID: "810001", frn: FRN_DELTA, holdingCompany: "Shared Holdco Inc" }),
					familyFixtureRow({ form499ID: "810002", frn: FRN_EPSILON, holdingCompany: "Shared Holdco Inc" }),
					familyFixtureRow({ form499ID: "810003", frn: FRN_ZETA, holdingCompany: "Shared Holdco Inc" }),
				]

				await buildFilerDatabase({
					form499Rows: rows,
					out,
					sourceVintage: SOURCE_VINTAGE,
					buildSHA: "deadbeef",
				})

				using db = openFilerDB(out)

				const families = await db
					.selectFrom("filer_family")
					.selectAll()
					.where("relationship", "=", FilerRelationship.HoldingCompany)
					.execute()

				expect(families).toHaveLength(3)

				const familyIDs = new Set(families.map((f) => f.family_id))
				expect(familyIDs.size).toBe(1)

				const memberNodeIDs = families.map((f) => f.node_id).toSorted()

				expect(memberNodeIDs).toEqual(
					[
						`${FilerIdentifierType.FRN}:${FRN_DELTA}`,
						`${FilerIdentifierType.FRN}:${FRN_EPSILON}`,
						`${FilerIdentifierType.FRN}:${FRN_ZETA}`,
					].toSorted()
				)

				for (const family of families) {
					expect(family.source).toBe("form-499")
					expect(family.source_vintage).toBe("2026-05-01")
					expect(family.valid_from).toBe("2026-05-01")
					expect(family.valid_to).toBeNull()
				}
			} finally {
				await teardownScratch()
			}
		})

		it("a filer whose holding company differs from its management company gets two family memberships under different relationships", async () => {
			await setupScratch()

			try {
				const row = familyFixtureRow({
					form499ID: "820001",
					frn: FRN_DELTA,
					holdingCompany: "Holdco Alpha Inc",
					managementCompany: "Manager Beta LLC",
				})

				await buildFilerDatabase({
					form499Rows: [row],
					out,
					sourceVintage: SOURCE_VINTAGE,
					buildSHA: "deadbeef",
				})

				using db = openFilerDB(out)
				const frnNodeID = `${FilerIdentifierType.FRN}:${FRN_DELTA}`

				const families = await db.selectFrom("filer_family").selectAll().where("node_id", "=", frnNodeID).execute()

				expect(families).toHaveLength(2)

				const byRelationship = new Map(families.map((f) => [f.relationship, f]))
				expect(byRelationship.get(FilerRelationship.HoldingCompany)).toBeDefined()
				expect(byRelationship.get(FilerRelationship.ManagementCompany)).toBeDefined()

				expect(byRelationship.get(FilerRelationship.HoldingCompany)!.family_id).not.toBe(
					byRelationship.get(FilerRelationship.ManagementCompany)!.family_id
				)
			} finally {
				await teardownScratch()
			}
		})

		it("never emits a filer_family row derived from a DC-agent field", async () => {
			await setupScratch()

			try {
				await buildFilerDatabase({
					form499Rows: form499FixtureRows(),
					out,
					sourceVintage: "2026-Q1",
					buildSHA: "deadbeef",
				})

				using db = openFilerDB(out)
				const families = await db.selectFrom("filer_family").selectAll().execute()

				// form499FixtureRows' FRN_ACME row has BOTH a holdingCompany and a managementCompany, so this suite
				// isn't vacuously passing on account of there being no family rows at all.
				expect(families.length).toBeGreaterThan(0)

				for (const family of families) {
					expect(family.family_id).not.toContain("CT Corporation")
					expect(family.family_id).not.toContain("John Doe")
					expect(family.node_id).not.toContain("CT Corporation")
					expect(family.node_id).not.toContain("John Doe")
				}
			} finally {
				await teardownScratch()
			}
		})

		it("collapses a same-source/same-vintage duplicate row's family rows within one build", async () => {
			await setupScratch()

			try {
				const row = familyFixtureRow({
					form499ID: "830001",
					frn: FRN_DELTA,
					holdingCompany: "Dup Holdco Inc",
				})

				const result = await buildFilerDatabase({
					form499Rows: [row, row],
					out,
					sourceVintage: SOURCE_VINTAGE,
					buildSHA: "deadbeef",
				})

				expect(result.families).toBe(1)

				using db = openFilerDB(out)
				const familyRows = await db.selectFrom("filer_family").selectAll().execute()
				expect(familyRows).toHaveLength(1)
			} finally {
				await teardownScratch()
			}
		})

		it("rebuilding the same inputs does not grow filer_family row counts", async () => {
			await setupScratch()

			try {
				const rows = [
					familyFixtureRow({
						form499ID: "840001",
						frn: FRN_DELTA,
						holdingCompany: "Repeat Holdco Inc",
						managementCompany: "Repeat Mgmt Co",
					}),
				]

				const first = await buildFilerDatabase({
					form499Rows: rows,
					out,
					sourceVintage: SOURCE_VINTAGE,
					buildSHA: "deadbeef",
				})

				const second = await buildFilerDatabase({
					form499Rows: rows,
					out,
					sourceVintage: SOURCE_VINTAGE,
					buildSHA: "deadbeef",
				})

				expect(first.families).toBe(2)
				expect(second.families).toBe(first.families)

				using db = openFilerDB(out)
				const familyRows = await db.selectFrom("filer_family").selectAll().execute()
				expect(familyRows).toHaveLength(2)
			} finally {
				await teardownScratch()
			}
		})
	})

	describe("EDGAR Exhibit 21 ingest (3b task 8)", () => {
		const CIK_PARENT = "0001234567"
		const EDGAR_SOURCE_VINTAGE = "2026-Q3-edgar"

		function edgarFixtureRow(
			overrides: Partial<EdgarSubsidiaryRow> & Pick<EdgarSubsidiaryRow, "subsidiaryName">
		): EdgarSubsidiaryRow {
			return { cik: CIK_PARENT, filingDate: "2026-04-01", ...overrides }
		}

		/**
		 * A minimal, fully-blank Form499Row overridden per test — matches `familyFixtureRow`'s convention one describe
		 * block up (that one is function-scoped there, so this describe block needs its own copy).
		 */
		function corroborationForm499Row(
			overrides: Partial<Form499Row> & Pick<Form499Row, "form499ID" | "frn" | "legalNameOfCarrier">
		): Form499Row {
			return {
				lastFiledAt: "2026-04-01",
				usfContributor: false,
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

		it("always writes the authoritative disclosure edge (cik -> subsidiary name), even with no matching FRN", async () => {
			await setupScratch()

			try {
				await buildFilerDatabase({
					edgarRows: [edgarFixtureRow({ subsidiaryName: "Unmatched Sub LLC", jurisdiction: "Delaware" })],
					out,
					sourceVintage: EDGAR_SOURCE_VINTAGE,
					buildSHA: "deadbeef",
				})

				using db = openFilerDB(out)
				const cikNodeID = `${FilerIdentifierType.CIK}:${CIK_PARENT}`
				const subsidiaryNodeID = `${FilerIdentifierType.SubsidiaryName}:Unmatched Sub LLC`

				const cikNode = await db
					.selectFrom("filer_node")
					.selectAll()
					.where("node_id", "=", cikNodeID)
					.executeTakeFirst()

				expect(cikNode).toEqual({
					node_id: cikNodeID,
					identifier_type: FilerIdentifierType.CIK,
					identifier_value: CIK_PARENT,
				})

				const edges = await db.selectFrom("filer_edge").selectAll().where("from_node_id", "=", cikNodeID).execute()
				expect(edges).toHaveLength(1)

				expect(edges[0]).toMatchObject({
					to_node_id: subsidiaryNodeID,
					assertion: FilerEdgeAssertion.Authoritative,
					relationship: FilerRelationship.Subsidiary,
					source: "edgar-exhibit-21",
					source_vintage: "2026-04-01",
					valid_from: "2026-04-01",
				})

				// No corroboration possible (no form499Rows at all) — no family row for this build.
				const familyRows = await db.selectFrom("filer_family").selectAll().execute()
				expect(familyRows).toHaveLength(0)
			} finally {
				await teardownScratch()
			}
		})

		it("edgarRows ALONE satisfies the 'at least one source' guard — it does not require form499/provider data", async () => {
			await setupScratch()

			try {
				await expect(
					buildFilerDatabase({
						edgarRows: [edgarFixtureRow({ subsidiaryName: "Standalone Sub LLC" })],
						out,
						sourceVintage: EDGAR_SOURCE_VINTAGE,
						buildSHA: "deadbeef",
					})
				).resolves.toBeDefined()
			} finally {
				await teardownScratch()
			}
		})

		it("the manifest's source includes edgar-exhibit-21 only when edgarRows was actually supplied", async () => {
			await setupScratch()

			try {
				await buildFilerDatabase({
					edgarRows: [edgarFixtureRow({ subsidiaryName: "Manifest Sub LLC" })],
					out,
					sourceVintage: EDGAR_SOURCE_VINTAGE,
					buildSHA: "deadbeef",
				})

				using db = openFilerDB(out)
				const manifest = await readFilerManifest(db)
				expect(manifest.source).toBe("edgar-exhibit-21")
			} finally {
				await teardownScratch()
			}
		})

		it("a subsidiary name matching (canonically) exactly one FRN's legal name writes BOTH an inferred filer_edge AND a filer_family row — the Task 8 precondition, load-bearing", async () => {
			await setupScratch()

			try {
				const frn = toFRN("0009700001")!

				await buildFilerDatabase({
					form499Rows: [
						corroborationForm499Row({ form499ID: "970001", frn, legalNameOfCarrier: "Trailhead Broadband LLC" }),
					],
					edgarRows: [edgarFixtureRow({ subsidiaryName: "Trailhead Broadband LLC" })],
					out,
					sourceVintage: EDGAR_SOURCE_VINTAGE,
					buildSHA: "deadbeef",
				})

				using db = openFilerDB(out)
				const frnNodeID = `${FilerIdentifierType.FRN}:${frn}`
				const cikNodeID = `${FilerIdentifierType.CIK}:${CIK_PARENT}`

				// The inferred FRN -> CIK edge.
				const inferredEdges = await db
					.selectFrom("filer_edge")
					.selectAll()
					.where("from_node_id", "=", frnNodeID)
					.where("to_node_id", "=", cikNodeID)
					.execute()

				expect(inferredEdges).toHaveLength(1)

				expect(inferredEdges[0]).toMatchObject({
					assertion: FilerEdgeAssertion.Inferred,
					relationship: FilerRelationship.ParentCompany,
					source: "edgar-exhibit-21",
					match_score: 0.92,
				})

				// THE PRECONDITION: the SAME fact also lands as a filer_family row, not just the edge above.
				const familyRows = await db
					.selectFrom("filer_family")
					.selectAll()
					.where("node_id", "=", frnNodeID)
					.where("family_id", "=", cikNodeID)
					.execute()

				expect(familyRows).toHaveLength(1)

				expect(familyRows[0]).toMatchObject({
					naming_node_id: cikNodeID,
					relationship: FilerRelationship.ParentCompany,
					source: "edgar-exhibit-21",
					valid_to: null,
				})
			} finally {
				await teardownScratch()
			}
		})

		it("abstains (no inferred edge, no family row) when the subsidiary name matches TWO DIFFERENT FRNs — a genuine name collision, never picked arbitrarily", async () => {
			await setupScratch()

			try {
				const frnA = toFRN("0009700002")!
				const frnB = toFRN("0009700003")!

				await buildFilerDatabase({
					form499Rows: [
						corroborationForm499Row({ form499ID: "970002", frn: frnA, legalNameOfCarrier: "Collision Sub LLC" }),
						corroborationForm499Row({ form499ID: "970003", frn: frnB, legalNameOfCarrier: "Collision Sub, LLC" }),
					],
					edgarRows: [edgarFixtureRow({ subsidiaryName: "Collision Sub LLC" })],
					out,
					sourceVintage: EDGAR_SOURCE_VINTAGE,
					buildSHA: "deadbeef",
				})

				using db = openFilerDB(out)
				const cikNodeID = `${FilerIdentifierType.CIK}:${CIK_PARENT}`

				const inferredEdges = await db
					.selectFrom("filer_edge")
					.selectAll()
					.where("to_node_id", "=", cikNodeID)
					.where("assertion", "=", FilerEdgeAssertion.Inferred)
					.execute()

				expect(inferredEdges).toHaveLength(0)

				const familyRows = await db.selectFrom("filer_family").selectAll().where("family_id", "=", cikNodeID).execute()
				expect(familyRows).toHaveLength(0)

				// The disclosure edge still stands — abstention is about the CORROBORATION only.
				const disclosureEdges = await db
					.selectFrom("filer_edge")
					.selectAll()
					.where("from_node_id", "=", cikNodeID)
					.execute()

				expect(disclosureEdges).toHaveLength(1)
			} finally {
				await teardownScratch()
			}
		})

		it("a malformed CIK (not zero-padded 10 digits) is loud", async () => {
			await setupScratch()

			try {
				await expect(
					buildFilerDatabase({
						edgarRows: [{ cik: "123", subsidiaryName: "Bad CIK Sub LLC", filingDate: "2026-04-01" }],
						out,
						sourceVintage: EDGAR_SOURCE_VINTAGE,
						buildSHA: "deadbeef",
					})
				).rejects.toThrow(/cik must be a zero-padded 10-digit string/)
			} finally {
				await teardownScratch()
			}
		})

		it("an empty subsidiaryName is loud", async () => {
			await setupScratch()

			try {
				await expect(
					buildFilerDatabase({
						edgarRows: [edgarFixtureRow({ subsidiaryName: "" })],
						out,
						sourceVintage: EDGAR_SOURCE_VINTAGE,
						buildSHA: "deadbeef",
					})
				).rejects.toThrow(/empty subsidiaryName/)
			} finally {
				await teardownScratch()
			}
		})

		it("a non-ISO filingDate is loud", async () => {
			await setupScratch()

			try {
				await expect(
					buildFilerDatabase({
						edgarRows: [edgarFixtureRow({ subsidiaryName: "Bad Date Sub LLC", filingDate: "2026-Q1" })],
						out,
						sourceVintage: EDGAR_SOURCE_VINTAGE,
						buildSHA: "deadbeef",
					})
				).rejects.toThrow(/not an ISO YYYY-MM-DD date/)
			} finally {
				await teardownScratch()
			}
		})
	})
})
