/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds and seals `filer.db` from Form 499, BDC provider-list and EDGAR Exhibit 21 rows.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { removePath, movePath, makeDirectories } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { countRows } from "@mailwoman/sqlite"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase } from "@mailwoman/sqlite/sealed-db"
import { dirname, type PathBuilderLike } from "path-ts"

import {
	createFilerAttributeNodeIndex,
	createFilerClusterIndex,
	createFilerEdgeToNodeIndex,
	createFilerFamilyIndex,
	FILER_SCHEMA_VERSION,
	FilerEdgeAssertion,
	FilerIdentifierType,
	FilerRelationship,
	type FilerDatabase,
} from "#schema"
import { groupFRNsByCanonicalLegalName } from "#sdk/build/edgar/match"
import { processEdgarSubsidiaryRow, type EdgarSubsidiaryRow } from "#sdk/build/edgar/rows"
import { insertFamilyMembership } from "#sdk/build/family-membership"
import {
	processForm499FRNRelationships,
	processForm499Lifecycle,
	type Form499LifecycleTotals,
} from "#sdk/build/form499-rows"
import {
	assertLastFiledAt,
	assertProviderValidFrom,
	mintForm499NodeID,
	mintFRNNodeID,
	mintHoldingCompanyNodeID,
	mintProviderNodeID,
} from "#sdk/build/node-ids"
import { createFilerBuildTables } from "#sdk/build/tables"
import { classifyFiler, parseForm499, type Form499Row } from "#sdk/form499/index"
import { assertISODate } from "#sdk/guards"
import { parseProviderList, type ProviderListRow } from "#sdk/provider-list"

export type { EdgarSubsidiaryRow } from "#sdk/build/edgar/rows"

/**
 * Number of source rows per transaction.
 */
const STAGE_BATCH_SIZE = 10_000

/**
 * Inputs for {@link buildFilerDatabase}.
 * At least one row source is required.
 */
export interface BuildFilerOptions {
	/**
	 * Form 499 rows.
	 * They take precedence over `form499Path`.
	 */
	form499Rows?: AsyncIterable<Form499Row> | Iterable<Form499Row>
	/**
	 * Provider-list rows.
	 * They take precedence over `providerListPath`.
	 */
	providerRows?: AsyncIterable<ProviderListRow> | Iterable<ProviderListRow>
	/**
	 * Exhibit 21 rows.
	 *
	 * Without Form 499 rows, the build links only the disclosures.
	 */
	edgarRows?: AsyncIterable<EdgarSubsidiaryRow> | Iterable<EdgarSubsidiaryRow>
	/**
	 * Path to the Form 499 TSV.
	 */
	form499Path?: string
	/**
	 * Path to the BDC provider-list CSV.
	 */
	providerListPath?: string
	/**
	 * Output path for the sealed database.
	 */
	out: PathBuilderLike
	/**
	 * Vintage recorded in the manifest and on provider-list edges.
	 */
	sourceVintage: string
	/**
	 * ISO `valid_from` date for provider-list edges.
	 *
	 * It is required when provider-list input is present.
	 * The build never derives it from `sourceVintage`.
	 */
	validFrom?: string
	/**
	 * Short Git revision recorded in the manifest.
	 */
	buildSHA: string
	onProgress?: (message: string) => void
}

/**
 * Row counts for a completed build.
 */
export interface BuildFilerResult {
	out: string
	nodes: number
	edges: number
	attributes: number
	families: number
	/**
	 * Count of optional edges skipped because a source field was empty.
	 */
	skipped: number
	/**
	 * Count of edges closed by a Form 499 cessation note.
	 */
	closedByCessation: number
	/**
	 * Count of cessations dated on or before `lastFiledAt`.
	 *
	 * These cannot close a valid window, so their dates stay as `ceased_at` attributes.
	 */
	cessationWindowAbstained: number
	/**
	 * Count of `SupersededBy` edges from replacement notes.
	 */
	supersessions: number
}

/**
 * Builds, seals and installs a `filer.db` snapshot.
 *
 * Each build replaces the previous file with a complete single-vintage snapshot.
 */
export async function buildFilerDatabase(options: BuildFilerOptions): Promise<BuildFilerResult> {
	const progress = options.onProgress ?? (() => {})

	const hasForm499Source = Boolean(options.form499Rows ?? options.form499Path)
	const hasProviderSource = Boolean(options.providerRows ?? options.providerListPath)
	const hasEdgarSource = Boolean(options.edgarRows)

	if (!hasForm499Source && !hasProviderSource && !hasEdgarSource) {
		throw new Error(
			"buildFilerDatabase: pass at least one of form499Rows/form499Path, providerRows/providerListPath, or edgarRows"
		)
	}

	// The date is checked before any I/O.
	const providerValidFrom = hasProviderSource ? assertProviderValidFrom(options.validFrom) : null

	const buildingPath = `${options.out}.building`

	if (await pathExists(buildingPath)) {
		await removePath(buildingPath)
	}

	await makeDirectories(dirname(options.out))

	const form499Source: AsyncIterable<Form499Row> | Iterable<Form499Row> =
		options.form499Rows ?? (options.form499Path ? parseForm499(options.form499Path) : [])

	const providerSource: AsyncIterable<ProviderListRow> | Iterable<ProviderListRow> =
		options.providerRows ?? (options.providerListPath ? parseProviderList(options.providerListPath) : [])

	const edgarSource: AsyncIterable<EdgarSubsidiaryRow> | Iterable<EdgarSubsidiaryRow> = options.edgarRows ?? []

	const lifecycleTotals: Form499LifecycleTotals = { closed: 0, abstained: 0, supersessions: 0 }
	let skipped = 0

	// The counts outlive the connection, which closes at the end of the block below.
	let materialized: { nodes: number; edges: number; attributes: number; families: number }

	{
		using kdb = new DatabaseClient<FilerDatabase>(buildingPath)
		kdb.exec("PRAGMA page_size=8192; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-2000000;")

		progress("creating manifest/node/edge/attribute/cluster/family/attribute-stage tables")
		await createFilerBuildTables(kdb)

		const insNode = kdb.prepare(
			`INSERT OR IGNORE INTO filer_node (node_id, identifier_type, identifier_value) VALUES (?, ?, ?)`
		)

		const insEdge = kdb.prepare(
			`INSERT OR IGNORE INTO filer_edge (
				from_node_id, to_node_id, assertion, relationship, source, source_vintage, valid_from, valid_to, match_score, evidence
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)

		const insFamily = kdb.prepare(
			`INSERT OR IGNORE INTO filer_family (
				node_id, family_id, naming_node_id, assertion, relationship, source, source_vintage, valid_from, valid_to, match_score
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)

		const insAttrStage = kdb.prepare(
			`INSERT OR IGNORE INTO filer_attribute_stage (node_id, key, value, source, source_vintage) VALUES (?, ?, ?, ?, ?)`
		)

		let batch = 0

		function commitBatch(): void {
			batch++

			if (batch >= STAGE_BATCH_SIZE) {
				kdb.exec("COMMIT")
				kdb.exec("BEGIN")
				batch = 0
			}
		}

		function stageAttribute(nodeID: string, key: string, value: string, source: string, sourceVintage: string): void {
			if (!value) return

			insAttrStage.run(nodeID, key, value, source, sourceVintage)
		}

		progress("staging nodes/edges/attributes — raw prepared INSERT OR IGNORE")
		kdb.exec("BEGIN")

		// The EDGAR pass matches subsidiary names against these Form 499 legal names.
		const legalNameByFRN = new Map<string, { name: string; filedAt: string }>()

		let form499RowIndex = 0

		for await (const row of form499Source) {
			form499RowIndex++

			const form499NodeID = mintForm499NodeID(row.form499ID, form499RowIndex)
			insNode.run(form499NodeID, FilerIdentifierType.Form499ID, row.form499ID)

			const lastFiledAt = assertISODate(
				assertLastFiledAt(row.lastFiledAt, row.form499ID, form499RowIndex),
				`form499 row #${form499RowIndex} (form499ID=${stringifyJSON(row.form499ID)}) lastFiledAt`
			)

			// Attributes attach to the Form 499 node, which every row has.
			// The build stores DC-agent fields as attributes only.
			stageAttribute(form499NodeID, "legal_name", row.legalNameOfCarrier, "form-499", lastFiledAt)
			stageAttribute(form499NodeID, "dba", row.doingBusinessAs, "form-499", lastFiledAt)

			for (const classification of classifyFiler(row)) {
				stageAttribute(form499NodeID, "classification", classification, "form-499", lastFiledAt)
			}

			stageAttribute(form499NodeID, "hq_address", row.hqAddress, "form-499", lastFiledAt)

			stageAttribute(
				form499NodeID,
				"customer_inquiries_telephone",
				row.customerInquiriesTelephone,
				"form-499",
				lastFiledAt
			)

			stageAttribute(form499NodeID, "customer_inquiries_address", row.customerInquiriesAddress, "form-499", lastFiledAt)

			stageAttribute(form499NodeID, "dc_agent_display_name", row.dcAgentDisplayName, "form-499", lastFiledAt)

			stageAttribute(form499NodeID, "dc_agent_organization_name", row.dcAgentOrganizationName, "form-499", lastFiledAt)

			stageAttribute(form499NodeID, "dc_agent_telephone", row.dcAgentTelephone, "form-499", lastFiledAt)
			stageAttribute(form499NodeID, "dc_agent_email_address", row.dcAgentEmailAddress, "form-499", lastFiledAt)
			stageAttribute(form499NodeID, "dc_agent_address", row.dcAgentAddress, "form-499", lastFiledAt)

			// Only workbook input carries lifecycle notes.
			// The 17-column TSV lacks them.
			const relationshipValidTo = processForm499Lifecycle(insNode, insEdge, stageAttribute, lifecycleTotals, {
				lifecycle: row.lifecycle,
				form499NodeID,
				lastFiledAt,
			})

			if (row.frn) {
				skipped += processForm499FRNRelationships(insNode, insEdge, insFamily, legalNameByFRN, {
					row,
					frn: row.frn,
					form499NodeID,
					form499RowIndex,
					lastFiledAt,
					relationshipValidTo,
				})
			} else {
				// A row may omit its FRN.
				// Such a row produces no FRN edges.
				skipped++
			}

			commitBatch()
		}

		let providerRowIndex = 0

		for await (const row of providerSource) {
			providerRowIndex++

			const providerNodeID = mintProviderNodeID(row.providerID, providerRowIndex)
			insNode.run(providerNodeID, FilerIdentifierType.BDCProviderID, String(row.providerID))

			const frnNodeID = mintFRNNodeID(row.frn, `provider-list row #${providerRowIndex} (providerID=${row.providerID})`)
			insNode.run(frnNodeID, FilerIdentifierType.FRN, row.frn)

			insEdge.run(
				providerNodeID,
				frnNodeID,
				FilerEdgeAssertion.Authoritative,
				FilerRelationship.SameEntity,
				"bdc-provider-list",
				options.sourceVintage,
				providerValidFrom!,
				null,
				null,
				null
			)

			if (row.holdingCompany) {
				const holdingNodeID = mintHoldingCompanyNodeID(row.holdingCompany)
				insNode.run(holdingNodeID, FilerIdentifierType.HoldingCompanyName, row.holdingCompany)

				insEdge.run(
					providerNodeID,
					holdingNodeID,
					FilerEdgeAssertion.Authoritative,
					FilerRelationship.HoldingCompany,
					"bdc-provider-list",
					options.sourceVintage,
					providerValidFrom!,
					null,
					null,
					null
				)

				insertFamilyMembership(insFamily, {
					memberNodeID: providerNodeID,
					namingNodeID: holdingNodeID,
					identifierType: FilerIdentifierType.HoldingCompanyName,
					name: row.holdingCompany,
					relationship: FilerRelationship.HoldingCompany,
					assertion: FilerEdgeAssertion.Authoritative,
					matchScore: null,
					source: "bdc-provider-list",
					sourceVintage: options.sourceVintage,
					validFrom: providerValidFrom!,
				})
			} else {
				skipped++
			}

			commitBatch()
		}

		// The groups must wait until every Form 499 name is collected.
		const frnsByCanonicalLegalName = groupFRNsByCanonicalLegalName(legalNameByFRN)

		let edgarRowIndex = 0

		for await (const row of edgarSource) {
			edgarRowIndex++
			processEdgarSubsidiaryRow(insNode, insEdge, insFamily, frnsByCanonicalLegalName, row, edgarRowIndex)
			commitBatch()
		}

		kdb.exec("COMMIT")

		const stagedCountRow = kdb.prepare("SELECT COUNT(*) AS staged_count FROM filer_attribute_stage").get() as {
			staged_count: number
		}

		progress(`staged ${stagedCountRow.staged_count.toLocaleString()} distinct attribute fact(s)`)

		progress("materializing filer_attribute from the staged, deduped facts")

		kdb.exec(
			`INSERT INTO filer_attribute (node_id, key, value, source, source_vintage)
			 SELECT node_id, key, value, source, source_vintage FROM filer_attribute_stage`
		)

		await kdb.schema.dropTable("filer_attribute_stage").execute()

		progress("index-after-load")
		await createFilerEdgeToNodeIndex(kdb)
		await createFilerAttributeNodeIndex(kdb)
		await createFilerClusterIndex(kdb)
		await createFilerFamilyIndex(kdb)

		const sourcesUsed: string[] = []

		if (hasForm499Source) {
			sourcesUsed.push("form-499")
		}

		if (hasProviderSource) {
			sourcesUsed.push("bdc-provider-list")
		}

		if (hasEdgarSource) {
			sourcesUsed.push("edgar-exhibit-21")
		}

		progress("writing filer_manifest")

		await kdb
			.insertInto("filer_manifest")
			.values({
				name: "filer",
				version: options.sourceVintage,
				schema_version: FILER_SCHEMA_VERSION,
				source: sourcesUsed.join(","),
				source_vintage: options.sourceVintage,
				build_cmd: "buildFilerDatabase (@mailwoman/filer/sdk)",
				build_sha: options.buildSHA,
				created_at: new Date().toISOString(),
			})
			.execute()

		materialized = {
			nodes: countRows(kdb, "filer_node"),
			edges: countRows(kdb, "filer_edge"),
			attributes: countRows(kdb, "filer_attribute"),
			families: countRows(kdb, "filer_family"),
		}

		progress(
			`materialized ${materialized.nodes.toLocaleString()} node(s), ${materialized.edges.toLocaleString()} edge(s), ` +
				`${materialized.attributes.toLocaleString()} attribute(s), ` +
				`${materialized.families.toLocaleString()} family membership(s) ` +
				`(${skipped.toLocaleString()} edge opportunity/ies skipped)`
		)

		progress("finalize: ANALYZE + VACUUM")
		kdb.exec("ANALYZE")
		// VACUUM applies the page size.
		// Without this, node:sqlite keeps its 4096-byte default.
		kdb.exec("PRAGMA page_size=8192")
		kdb.exec("VACUUM")
	}

	progress("seal")
	await sealDatabase(buildingPath)

	if (await pathExists(options.out)) {
		await movePath(options.out, `${options.out}.prev`)
	}

	await movePath(buildingPath, options.out)

	if (await pathExists(`${options.out}.prev`)) {
		await removePath(`${options.out}.prev`)
	}

	return {
		out: options.out.toString(),
		nodes: materialized.nodes,
		edges: materialized.edges,
		attributes: materialized.attributes,
		families: materialized.families,
		skipped,
		closedByCessation: lifecycleTotals.closed,
		cessationWindowAbstained: lifecycleTotals.abstained,
		supersessions: lifecycleTotals.supersessions,
	}
}
