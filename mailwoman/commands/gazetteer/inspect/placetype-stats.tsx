/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer inspect placetype-stats [--country XX] [--db <path>] [--json]` — tally WOF
 *   placetype statistics + hierarchy relationships from the unified admin DB (`spr` + `ancestors`).
 *
 *   Motivation (the `dependent_locality` dead-tag investigation): the trained model struggles with rare
 *   sub-locality tags because they have almost no WOF grounding, and we underuse WOF's statistical counts
 *   + parent/ancestor relationship chains. This surfaces, per placetype: the global row count, the
 *   distribution of its PARENT placetype (how the type relates upward), and its modal ANCESTOR-placetype
 *   chain. Read-only. The `--json` payload is shaped to feed an "effective placetype" soft-prior later.
 */

import { DatabaseSync } from "node:sqlite"

import { COMPONENT_TAGS } from "@mailwoman/core"
import { dataRootPath } from "@mailwoman/core/utils"
import { Box, Text } from "ink"
import zod from "zod"

import { commandError, type CommandComponent, useCommandTask } from "../../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	db: zod.string().optional().describe("WOF admin DB. Default: $MAILWOMAN_DATA_ROOT/wof/admin-global-priority.db"),
	country: zod
		.string()
		.regex(/^[A-Z]{2}$/u, "ISO 3166-1 alpha-2 (e.g. NZ, US)")
		.optional()
		.describe("Filter to one country's places"),
	json: zod.boolean().optional().describe("Emit the raw stats as JSON (feeds a soft-prior / Fable analysis)"),
})

export { OptionsSchema as options }

interface PlacetypeStat {
	placetype: string
	count: number
	/** How this placetype relates upward: its parent placetype distribution, as fractions summing to ~1. */
	parents: Array<{ placetype: string; fraction: number }>
	/** The modal ancestor-placetype chain (most common ancestor placetypes, ordered by frequency). */
	ancestors: Array<{ placetype: string; fraction: number }>
	/**
	 * True iff this WOF placetype maps to a trained `ComponentTag` (via core/types/mapping) — the ones the model must
	 * emit.
	 */
	trained: boolean
}

// WOF placetype -> mailwoman ComponentTag (mirrors core/types/mapping.ts; only the admin-hierarchy ones).
const PLACETYPE_TO_TAG: Record<string, string> = {
	country: "country",
	region: "region",
	locality: "locality",
	dependency: "dependent_locality",
	borough: "dependent_locality",
	macrohood: "dependent_locality",
	neighbourhood: "dependent_locality",
	county: "subregion",
	localadmin: "subregion",
}

const GazetteerPlacetypeStats: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const dbPath = options.db ?? dataRootPath("wof", "admin-global-priority.db").toString()
		const country = options.country

		let db: DatabaseSync
		try {
			db = new DatabaseSync(dbPath, { readOnly: true })
		} catch (error) {
			throw commandError(`Cannot open WOF DB ${dbPath}: ${(error as Error).message}`)
		}

		const where = country ? "AND s.country = ?" : ""
		const cWhere = country ? "AND c.country = ?" : ""
		const params = country ? [country] : []

		// 1) counts
		const counts = db
			.prepare(`SELECT placetype, count(*) AS n FROM spr s WHERE is_current = 1 ${where} GROUP BY placetype`)
			.all(...params) as unknown as Array<{ placetype: string; n: number }>

		// 2) parent-placetype distribution (child.parent_id -> parent.placetype)
		const parentRows = db
			.prepare(
				`SELECT c.placetype AS child, p.placetype AS parent, count(*) AS n
				 FROM spr c JOIN spr p ON c.parent_id = p.id
				 WHERE c.is_current = 1 ${cWhere} GROUP BY c.placetype, p.placetype`
			)
			.all(...params) as unknown as Array<{ child: string; parent: string; n: number }>

		// 3) ancestor-placetype distribution (via the ancestors chain table)
		const ancRows = db
			.prepare(
				`SELECT s.placetype AS pt, a.ancestor_placetype AS anc, count(*) AS n
				 FROM ancestors a JOIN spr s ON a.id = s.id
				 WHERE s.is_current = 1 ${where} GROUP BY s.placetype, a.ancestor_placetype`
			)
			.all(...params) as unknown as Array<{ pt: string; anc: string; n: number }>

		db.close()

		const byParent = new Map<string, Array<{ placetype: string; n: number }>>()
		for (const r of parentRows) {
			const list = byParent.get(r.child) ?? []
			list.push({ placetype: r.parent, n: r.n })
			byParent.set(r.child, list)
		}
		const byAnc = new Map<string, Array<{ placetype: string; n: number }>>()
		for (const r of ancRows) {
			const list = byAnc.get(r.pt) ?? []
			list.push({ placetype: r.anc, n: r.n })
			byAnc.set(r.pt, list)
		}
		const dist = (list: Array<{ placetype: string; n: number }> | undefined) => {
			if (!list?.length) return []
			const tot = list.reduce((s, x) => s + x.n, 0) || 1
			return list
				.sort((a, b) => b.n - a.n)
				.slice(0, 5)
				.map((x) => ({ placetype: x.placetype, fraction: x.n / tot }))
		}

		const tags = new Set<string>(COMPONENT_TAGS as readonly string[])
		const stats: PlacetypeStat[] = counts
			.sort((a, b) => b.n - a.n)
			.map((c) => ({
				placetype: c.placetype,
				count: c.n,
				parents: dist(byParent.get(c.placetype)),
				ancestors: dist(byAnc.get(c.placetype)),
				trained: tags.has(PLACETYPE_TO_TAG[c.placetype] ?? ""),
			}))

		return { dbPath, country: country ?? "ALL", stats }
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>
	if (state.status !== "done") return null

	if (options.json) return <Text>{JSON.stringify(state.result, null, 2)}</Text>

	const { stats, country } = state.result
	const pct = (f: number) => `${Math.round(f * 100)}%`
	const distStr = (d: Array<{ placetype: string; fraction: number }>) =>
		d.length ? d.map((x) => `${x.placetype} ${pct(x.fraction)}`).join(", ") : "—"

	return (
		<Box flexDirection="column">
			<Text bold>
				WOF placetype stats · {country} · {stats.length} placetypes
			</Text>
			<Text dimColor>{`${"placetype".padEnd(20)} count      trained  parent-placetype distribution`}</Text>
			{stats.map((s) => (
				<Text key={s.placetype} color={s.trained ? undefined : "gray"}>
					{s.placetype.padEnd(20)} {String(s.count).padStart(9)} {s.trained ? "  ✓  " : "     "} {distStr(s.parents)}
				</Text>
			))}
			<Text> </Text>
			<Text dimColor>Ancestor chains (rare/esoteric types):</Text>
			{stats
				.filter((s) => s.count < 200_000 && s.trained)
				.map((s) => (
					<Text key={`anc-${s.placetype}`}>
						{"  "}
						{s.placetype.padEnd(20)} ← {distStr(s.ancestors)}
					</Text>
				))}
		</Box>
	)
}

export default GazetteerPlacetypeStats
