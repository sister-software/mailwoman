/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Count, per declared-holdout country, the train and held-out rows that carry each region and locality as that
 *   component's span, and the train rows that still carry a held-out key.
 *
 *   A holdout keyed on a region removes the region as a label: a region's name appears as a region span only in rows
 *   from that region, so holding the region out leaves training with no region span for it, whatever other rows write
 *   the word inside a street or venue (#2777: v0.8.0 train held 0 region spans for VT, ND, WY, Asturias, Kerala and
 *   Cornwall, and the model relabeled them locality). A holdout therefore keys only on open-vocabulary places, a
 *   postcode district or a locality, and the check is two-sided: a held-out place has no train row, and every region
 *   keeps a train span supply near its country's median.
 *
 *   The count reads the corpus manifest's file list: a file recorded under a split counts toward that split, and a
 *   file decided by a split attribute counts each row toward the split its `source_id` is listed under, train when
 *   neither list holds it. A span's surface is folded with `foldNFKCWhitespace`, the folding `splitForRow` applies to
 *   a declared name.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { median } from "@mailwoman/core/stats"
import { foldNFKCWhitespace } from "@mailwoman/normalize/fold"

import { escapeSQLString, openDuckDB, type DuckDBLimits } from "#parquet/duckdb"
import { baseManifestFiles, localManifestFilePath } from "#tools/overlay/manifest"
import { readSplitAttribute } from "#tools/overlay/split-attribute"
import { type CountryHoldout, holdoutPolicyFor } from "#utils/split"

/**
 * The span tags a place is named by.
 */
export type HoldoutSpanTag = "region" | "locality"

/**
 * One folded surface of one country carried as a `tag` span, and the rows carrying it
 * on each side of the split, in all and among rows with no postcode span.
 */
export interface HoldoutSpanCount {
	country: string
	tag: HoldoutSpanTag
	surface: string
	trainRows: number
	heldOutRows: number
	trainRowsWithoutPostcode: number
	heldOutRowsWithoutPostcode: number
}

/**
 * The train rows of one country whose first postcode span begins with one declared prefix.
 */
export interface HoldoutPostcodeCount {
	country: string
	prefix: string
	trainRows: number
}

export interface HoldoutSpanCountResult {
	counts: HoldoutSpanCount[]
	postcodes: HoldoutPostcodeCount[]
	filesRead: number
}

const SEPARATOR = "\u0000"

/**
 * Count the rows of every country `holdouts` declares that carry each region surface,
 * and each declared locality, as that span, split into train rows and held-out
 * (val or test) rows, and the train rows carrying each declared postcode prefix.
 * A row carrying one surface twice counts once.
 *
 * @throws When a manifest file records neither a split nor a split attribute,
 * since reading it as train or as held out would both misstate the count.
 */
export async function countHoldoutSpans(
	manifestPath: string,
	holdouts: Record<string, CountryHoldout>,
	limits?: DuckDBLimits
): Promise<HoldoutSpanCountResult> {
	const files = baseManifestFiles(await readLocalJSONFile(manifestPath))
	const countries = Object.keys(holdouts)
	const totals = new Map<string, HoldoutSpanCount>()

	const prefixes = countries.flatMap((country) =>
		(holdoutPolicyFor(holdouts[country]!).postcodePrefixes ?? []).map((prefix) => ({ country, prefix, trainRows: 0 }))
	)

	// Locality spans are counted for the declared localities only: a country's locality
	// surfaces run to a million, and the check reads no other.
	const declaredLocalities = new Set(
		countries.flatMap((country) =>
			(holdoutPolicyFor(holdouts[country]!).localities ?? []).map((name) =>
				[country, "locality", foldNFKCWhitespace(name)].join(SEPARATOR)
			)
		)
	)

	if (!countries.length) return { counts: [], postcodes: [], filesRead: 0 }

	const quoted = (value: string) => `'${escapeSQLString(value)}'`

	const postcode =
		"CASE WHEN list_position(span_tags, 'postcode') > 0 THEN substring(raw, " +
		"span_starts[list_position(span_tags, 'postcode')] + 1, " +
		"span_ends[list_position(span_tags, 'postcode')] - span_starts[list_position(span_tags, 'postcode')]) END"

	const prefixColumns = prefixes.map(
		({ country, prefix }, index) =>
			`count(*) FILTER (WHERE NOT held_out AND country = ${quoted(country)} AND starts_with(postcode, ${quoted(prefix)})) AS p${index}`
	)

	using db = await openDuckDB(limits)

	await db.run("CREATE TEMP TABLE held_out_ids (id VARCHAR)")

	let filesRead = 0

	for (const file of files) {
		const split = file["split"]
		const reference = file["split_attribute"] as { path?: unknown } | undefined

		if (split !== "train" && split !== "val" && split !== "test" && typeof reference?.path !== "string") {
			throw new Error(`${manifestPath} lists ${file.path} with neither a split nor a split attribute`)
		}

		await db.run("DELETE FROM held_out_ids")

		if (typeof split !== "string") {
			const attribute = await readSplitAttribute(localManifestFilePath(reference!.path as string))
			const appender = await db.createAppender("held_out_ids")

			for (const id of [...attribute.val, ...attribute.test]) {
				appender.appendVarchar(id)
				appender.endRow()
			}

			appender.closeSync()
		}

		const heldOutExpression =
			typeof split === "string" ? (split === "train" ? "false" : "true") : "source_id IN (SELECT id FROM held_out_ids)"

		await db.run(
			`CREATE OR REPLACE TEMP TABLE r AS SELECT country, ${heldOutExpression} AS held_out, ${postcode} AS postcode, ` +
				`list_distinct([span_tags[i] || chr(0) || substring(raw, span_starts[i] + 1, span_ends[i] - span_starts[i]) ` +
				`FOR i IN range(1, len(span_tags) + 1) IF span_tags[i] IN ('region', 'locality')]) AS spans ` +
				`FROM read_parquet(${quoted(localManifestFilePath(file.path))}) ` +
				`WHERE country IN (${countries.map(quoted).join(", ")})`
		)

		const rows = (
			await db.runAndReadAll(
				`SELECT country, held_out, postcode IS NULL AS no_postcode, span, count(*)::BIGINT AS n ` +
					`FROM r, unnest(spans) AS t(span) GROUP BY ALL`
			)
		).getRowObjectsJson() as Array<{
			country: string
			held_out: boolean
			no_postcode: boolean
			span: string
			n: string
		}>

		for (const row of rows) {
			const separator = row.span.indexOf(SEPARATOR)
			const tag = row.span.slice(0, separator) as HoldoutSpanTag
			const surface = foldNFKCWhitespace(row.span.slice(separator + 1))
			const key = [row.country, tag, surface].join(SEPARATOR)

			if (tag === "locality" && !declaredLocalities.has(key)) continue

			const count = totals.get(key) ?? {
				country: row.country,
				tag,
				surface,
				trainRows: 0,
				heldOutRows: 0,
				trainRowsWithoutPostcode: 0,
				heldOutRowsWithoutPostcode: 0,
			}

			const n = Number(row.n)

			if (row.held_out) {
				count.heldOutRows += n

				if (row.no_postcode) {
					count.heldOutRowsWithoutPostcode += n
				}
			} else {
				count.trainRows += n

				if (row.no_postcode) {
					count.trainRowsWithoutPostcode += n
				}
			}

			totals.set(key, count)
		}

		if (prefixColumns.length) {
			const row = (await db.runAndReadAll(`SELECT ${prefixColumns.join(", ")} FROM r`)).getRowObjectsJson()[0]!

			for (const [index, prefix] of prefixes.entries()) {
				prefix.trainRows += Number(row[`p${index}`])
			}
		}

		filesRead++
	}

	return { counts: [...totals.values()], postcodes: prefixes, filesRead }
}

/**
 * The fewest rows a region surface must carry, across every split, before
 * {@linkcode holdoutSpanFindings} checks its train supply.
 *
 * A surface below this is a misspelling or a stray label rather than a region.
 */
export const REGION_SURFACE_MIN_ROWS = 100

/**
 * The lowest train share a region may keep, as a fraction of its country's median region train share.
 *
 * Holding out a place below the region takes a small part of every region it touches,
 * so each region's train share stays near the median.
 * A region held out whole falls to 0.
 */
export const REGION_TRAIN_SHARE_FLOOR = 0.5

/**
 * One way a holdout removes a label from training, or leaves a held-out place in it.
 */
export interface HoldoutSpanFinding {
	country: string
	/**
	 * - `region-key`: the policy lists a region, a closed-vocabulary label, as a key.
	 * - `locality-in-train`: a declared locality still carried by train rows.
	 * - `postcode-in-train`: a declared postcode prefix still carried by train rows.
	 * - `region-supply`: a region surface whose train share falls below
	 *   {@linkcode REGION_TRAIN_SHARE_FLOOR} of its country's median.
	 * - `region-supply-without-postcode`: the same among rows with no postcode.
	 */
	reason: "region-key" | "locality-in-train" | "postcode-in-train" | "region-supply" | "region-supply-without-postcode"
	key: string
	trainRows: number
	heldOutRows: number
}

/**
 * The region-supply findings for one country over one pair of train and held-out counts.
 */
function regionSupplyFindings(
	country: string,
	regions: readonly HoldoutSpanCount[],
	read: (count: HoldoutSpanCount) => [train: number, heldOut: number],
	reason: "region-supply" | "region-supply-without-postcode"
): HoldoutSpanFinding[] {
	const measured = regions
		.map((count) => ({ count, rows: read(count) }))
		.filter(({ rows: [train, heldOut] }) => train + heldOut >= REGION_SURFACE_MIN_ROWS)

	if (!measured.length) return []

	const floor =
		REGION_TRAIN_SHARE_FLOOR * median(measured.map(({ rows: [train, heldOut] }) => train / (train + heldOut)))!

	return measured
		.filter(({ rows: [train, heldOut] }) => train / (train + heldOut) < floor)
		.map(({ count, rows: [trainRows, heldOutRows] }) => ({
			country,
			reason,
			key: count.surface,
			trainRows,
			heldOutRows,
		}))
}

/**
 * The declared keys and region surfaces that `result` shows removing a label from
 * training or leaving a held-out place in it.
 */
export function holdoutSpanFindings(
	result: Pick<HoldoutSpanCountResult, "counts" | "postcodes">,
	holdouts: Record<string, CountryHoldout>
): HoldoutSpanFinding[] {
	const byKey = new Map(
		result.counts.map((count) => [[count.country, count.tag, count.surface].join(SEPARATOR), count])
	)

	const findings: HoldoutSpanFinding[] = []

	for (const [country, holdout] of Object.entries(holdouts)) {
		const policy = holdoutPolicyFor(holdout)

		for (const region of policy.regions ?? []) {
			const count = byKey.get([country, "region", foldNFKCWhitespace(region)].join(SEPARATOR))

			findings.push({
				country,
				reason: "region-key",
				key: region,
				trainRows: count?.trainRows ?? 0,
				heldOutRows: count?.heldOutRows ?? 0,
			})
		}

		for (const locality of new Set((policy.localities ?? []).map(foldNFKCWhitespace))) {
			const count = byKey.get([country, "locality", locality].join(SEPARATOR))

			if (count?.trainRows) {
				findings.push({
					country,
					reason: "locality-in-train",
					key: locality,
					trainRows: count.trainRows,
					heldOutRows: count.heldOutRows,
				})
			}
		}

		const regions = result.counts.filter((count) => count.country === country && count.tag === "region")

		findings.push(
			...regionSupplyFindings(country, regions, (count) => [count.trainRows, count.heldOutRows], "region-supply"),
			...regionSupplyFindings(
				country,
				regions,
				(count) => [count.trainRowsWithoutPostcode, count.heldOutRowsWithoutPostcode],
				"region-supply-without-postcode"
			)
		)
	}

	for (const postcode of result.postcodes) {
		if (!postcode.trainRows) continue

		findings.push({
			country: postcode.country,
			reason: "postcode-in-train",
			key: postcode.prefix,
			trainRows: postcode.trainRows,
			heldOutRows: 0,
		})
	}

	return findings
}
