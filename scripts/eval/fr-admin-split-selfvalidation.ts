/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fr-admin-split-selfvalidation.ts — the PRE-GPU gate for the international admin-split retrain
 *   (night 2026-06-19). Before spending an A100, falsify the premise: does splitting the
 *   département out of the locality actually move the resolved coordinate, anchor-ON, through the
 *   production resolver? Or does FTS land the same commune either way (DeepSeek's silent-wash risk
 *   — the v1.7.0 trap: a label change that the resolver ignores)?
 *
 *   For each sampled FR commune (truth = its own WOF centroid) we resolve THREE parse states through
 *   the SAME resolver the geocoder ships (`createWofResolver` over `admin-global-priority.db`,
 *   `defaultCountry: FR`):
 *
 *   - DROPPED {locality:[commune]} — the model's "région → null" failure
 *   - MERGED {locality:[commune + " " + dept]} — the "CANBERRA ACT" fuse failure
 *   - SPLIT {locality:[commune], region:[dept]} — the corrected parse and measure the great-circle
 *       error to the commune's true centroid.
 *
 *   The lever is REAL iff SPLIT's mean error is materially below DROPPED/MERGED — concentrated on
 *   COLLISION communes (a name in >1 département), where the région is the only disambiguator.
 *   UNIQUE communes are the control (the resolver should find them with or without the région).
 *
 *   Gate: ≥5% mean centroid-error reduction (SPLIT vs DROPPED) on the collision stratum, else STOP —
 *   the premise is false and no retrain can fix it.
 *
 *   Run (compiled CLI): node --experimental-strip-types scripts/eval/fr-admin-split-selfvalidation.ts\
 *   --db /mnt/playpen/mailwoman-data/wof/admin-global-priority.db --n 200 --out /tmp/fr-split.md
 */

import { type AddressNode, type AddressTree } from "@mailwoman/core/decoder"
import { createWofResolver } from "@mailwoman/core/resolver"
import type { ClassificationRecord } from "mailwoman"
import { DatabaseSync } from "node:sqlite"
import { v0RecordToTree } from "./v0-tree-adapter.ts"

// --- tiny helpers copied from oa-resolver-eval.ts (kept in lockstep, see that file) ----------------
const PLACETYPE_RANK: Record<string, number> = {
	postalcode: 6,
	locality: 5,
	localadmin: 4,
	borough: 4,
	county: 3,
	region: 2,
	country: 0,
}
interface Resolved {
	id: number
	name: string
	placetype: string
	lat: number
	lon: number
}
function collectResolved(tree: AddressTree): Resolved[] {
	const out: Resolved[] = []
	const visit = (n: AddressNode): void => {
		const meta = n.metadata as Record<string, unknown> | undefined
		if (n.placeId?.startsWith("wof:") && n.lat !== undefined && n.lon !== undefined) {
			const placetype = String(n.sourceId ?? "").split(":")[0] ?? ""
			const name = String(meta?.["resolver_name"] ?? n.value ?? "")
			out.push({ id: Number(n.placeId.slice(4)), name, placetype, lat: n.lat, lon: n.lon })
		}
		for (const c of n.children) visit(c)
	}
	for (const r of tree.roots) visit(r)
	return out
}
function mostSpecific(rs: Resolved[]): Resolved | null {
	let best: Resolved | null = null
	for (const r of rs) {
		if (!best || (PLACETYPE_RANK[r.placetype] ?? -1) > (PLACETYPE_RANK[best.placetype] ?? -1)) best = r
	}
	return best
}
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6371
	const dLat = ((lat2 - lat1) * Math.PI) / 180
	const dLon = ((lon2 - lon1) * Math.PI) / 180
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
	return 2 * R * Math.asin(Math.sqrt(a))
}
const pct = (xs: number[], p: number): number => {
	if (xs.length === 0) return NaN
	const s = [...xs].sort((a, b) => a - b)
	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!
}
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)

// --- args ----------------------------------------------------------------------------------------
const arg = (k: string, d: string): string => {
	const i = process.argv.indexOf(`--${k}`)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d
}
const DB = arg("db", "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db")
const N = Number(arg("n", "200")) // per stratum

// --- sample FR communes (collision + unique strata) ----------------------------------------------
const db = new DatabaseSync(DB, { readOnly: true })
interface Commune {
	id: number
	commune: string
	dept: string
	lat: number
	lon: number
	collisionCount: number
}
// Communes with their département (placetype 'region' in WOF-FR) + how many distinct départements
// share the same commune NAME (the collision degree — the disambiguation pressure).
const rows = db
	.prepare(
		`WITH fr_comm AS (
       SELECT l.id, l.name AS commune, l.latitude AS lat, l.longitude AS lon, r.name AS dept
       FROM spr l
       JOIN ancestors a ON a.id = l.id AND a.ancestor_placetype = 'region'
       JOIN spr r ON r.id = a.ancestor_id
       WHERE l.country = 'FR' AND l.placetype = 'locality' AND l.is_current = 1
         AND l.latitude != 0 AND l.name != '' AND r.name != ''
     ),
     coll AS (SELECT commune, COUNT(DISTINCT dept) c FROM fr_comm GROUP BY commune)
     SELECT f.id, f.commune, f.dept, f.lat, f.lon, coll.c AS collisionCount
     FROM fr_comm f JOIN coll ON coll.commune = f.commune`
	)
	.all() as unknown as Commune[]

// Deterministic shuffle (no Math.random in this env) — order by id hash.
const shuffled = [...rows].sort((a, b) => ((a.id * 2654435761) % 1e9) - ((b.id * 2654435761) % 1e9))
const collision = shuffled.filter((r) => r.collisionCount > 1).slice(0, N)
const unique = shuffled.filter((r) => r.collisionCount === 1).slice(0, N)
db.close()

// --- resolver (production path) ------------------------------------------------------------------
const { WofSqlitePlaceLookup } = await import("@mailwoman/resolver-wof-sqlite")
const backend = new WofSqlitePlaceLookup({ databasePath: DB })
const resolver = createWofResolver(backend as never)
const resolveOpts = { defaultCountry: "FR" }

// Unresolved penalty = the coordinate the geocoder actually falls back to when the place isn't
// found: the country centroid. Makes the three states comparable on ONE error metric (resolved
// point if found, else country-centroid) instead of averaging over different resolved subsets.
const FR_CENTROID = { lat: 46.6, lon: 2.5 }
type State = "dropped" | "merged" | "split"
async function resolveState(c: Commune, state: State): Promise<{ km: number; resolved: boolean }> {
	let raw: string
	let record: ClassificationRecord
	if (state === "dropped") {
		raw = c.commune
		record = { locality: [c.commune] } as ClassificationRecord
	} else if (state === "merged") {
		raw = `${c.commune} ${c.dept}`
		record = { locality: [`${c.commune} ${c.dept}`] } as ClassificationRecord
	} else {
		raw = `${c.commune}, ${c.dept}`
		record = { locality: [c.commune], region: [c.dept] } as ClassificationRecord
	}
	const { tree } = v0RecordToTree(raw, record)
	const decorated = await resolver.resolveTree(tree, resolveOpts)
	const best = mostSpecific(collectResolved(decorated))
	return best
		? { km: haversineKm(best.lat, best.lon, c.lat, c.lon), resolved: true }
		: { km: haversineKm(FR_CENTROID.lat, FR_CENTROID.lon, c.lat, c.lon), resolved: false }
}

// --- run -----------------------------------------------------------------------------------------
interface StratumAgg {
	dropped: number[]
	merged: number[]
	split: number[]
	res: { dropped: number; merged: number; split: number }
	splitBeatsDroppedBy2km: number
	n: number
}
async function runStratum(label: string, sample: Commune[]): Promise<StratumAgg> {
	const agg: StratumAgg = {
		dropped: [],
		merged: [],
		split: [],
		res: { dropped: 0, merged: 0, split: 0 },
		splitBeatsDroppedBy2km: 0,
		n: 0,
	}
	for (const c of sample) {
		const [d, m, s] = await Promise.all([
			resolveState(c, "dropped"),
			resolveState(c, "merged"),
			resolveState(c, "split"),
		])
		agg.n++
		agg.dropped.push(d.km)
		agg.merged.push(m.km)
		agg.split.push(s.km)
		if (d.resolved) agg.res.dropped++
		if (m.resolved) agg.res.merged++
		if (s.resolved) agg.res.split++
		if (d.km - s.km > 2) agg.splitBeatsDroppedBy2km++
	}
	console.error(`  ${label}: n=${agg.n} resolve-rate(d/m/s)=${agg.res.dropped}/${agg.res.merged}/${agg.res.split}`)
	return agg
}

console.error(`[fr-split] collision=${collision.length} unique=${unique.length} (from ${rows.length} FR communes)`)
const collAgg = await runStratum("collision", collision)
const uniqAgg = await runStratum("unique", unique)

// --- report --------------------------------------------------------------------------------------
const row = (label: string, a: StratumAgg): string => {
	const dM = mean(a.dropped),
		sM = mean(a.split)
	const reduction = dM > 0 ? (100 * (dM - sM)) / dM : 0
	const rr = (k: number): string => `${((100 * k) / a.n).toFixed(0)}%`
	return [
		`### ${label} (n=${a.n}) — error in km, unresolved penalized to FR centroid`,
		"",
		"| state | mean km | p50 | p90 | resolve-rate |",
		"| --- | --: | --: | --: | --: |",
		`| dropped (région→null) | ${mean(a.dropped).toFixed(1)} | ${pct(a.dropped, 50).toFixed(1)} | ${pct(a.dropped, 90).toFixed(1)} | ${rr(a.res.dropped)} |`,
		`| merged (loc=commune+dept) | ${mean(a.merged).toFixed(1)} | ${pct(a.merged, 50).toFixed(1)} | ${pct(a.merged, 90).toFixed(1)} | ${rr(a.res.merged)} |`,
		`| **split (corrected)** | **${mean(a.split).toFixed(1)}** | ${pct(a.split, 50).toFixed(1)} | ${pct(a.split, 90).toFixed(1)} | ${rr(a.res.split)} |`,
		"",
		`**SPLIT vs DROPPED mean reduction: ${reduction.toFixed(1)}%** · split beats dropped by >2km on ${a.splitBeatsDroppedBy2km}/${a.n} rows`,
		"",
	].join("\n")
}
const collReduction =
	mean(collAgg.dropped) > 0 ? (100 * (mean(collAgg.dropped) - mean(collAgg.split))) / mean(collAgg.dropped) : 0
const verdict =
	collReduction >= 5
		? `✅ LEVER REAL — collision SPLIT-vs-DROPPED reduction ${collReduction.toFixed(1)}% ≥ 5%. The resolver uses the région tag. Retrain premise holds.`
		: `❌ LEVER FALSE — collision reduction ${collReduction.toFixed(1)}% < 5%. The resolver lands the same place without the région. STOP — no retrain fixes this.`

const out = [
	"# FR admin-split self-validation (pre-GPU gate, 2026-06-19)",
	"",
	"Does splitting the département out of the locality move the resolved coordinate, anchor-ON, through the production resolver? Tested on FR communes (truth = WOF centroid), collision (name in >1 département) vs unique control.",
	"",
	row("Collision communes — where the région disambiguates", collAgg),
	row("Unique communes — control", uniqAgg),
	"## Verdict",
	"",
	verdict,
	"",
].join("\n")

const outPath = arg("out", "")
if (outPath) {
	const { writeFileSync } = await import("node:fs")
	writeFileSync(outPath, out)
	console.error(`[fr-split] wrote ${outPath}`)
}
console.log(out)
