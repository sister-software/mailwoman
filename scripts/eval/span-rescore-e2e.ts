/**
 * @copyright Sister Software · @license AGPL-3.0 · @author Teffen Ellis, et al.
 *
 *   #370 span-rescore — END-TO-END production validation (#780).
 *
 *   #777's eval graded a STANDALONE `spanRescore` function; #780 wired it into `resolveTree` behind
 *   `ResolveOpts.spanRescore`. This grades the WIRED path: parse → `resolveTree(spanRescore:false)`
 *   (baseline) vs `resolveTree(spanRescore:true)` (lever), on the same EU coord panel, coordinate-
 *   graded (#566). The question this answers that the unit tests can't: does flipping the production
 *   flag actually move the EU coordinate on real addresses, through the real walk + the real backend?
 *
 *   Backend = the demo's candidate gazetteer (EU coverage + the postcodes the gate needs — IT resolves,
 *   so the gate bites there; PL/PT don't, so the rescore runs ungated there, exactly as in production).
 *
 *   Run: node --experimental-strip-types scripts/eval/span-rescore-e2e.ts [--n 150]
 */
import { createWofResolver } from "@mailwoman/resolver"
import { haversineKm } from "@mailwoman/spatial"
import { existsSync, readFileSync } from "node:fs"

const arg = (k: string, d = "") => {
	const i = process.argv.indexOf(`--${k}`)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d
}
const TOK = "/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model"
const CARD = "neural-weights-en-us/model-card.json"
const ANCHOR = "/mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json"
const MODEL = arg("model", "out/v191/model.onnx")
const CAND = arg("candidate-db", "/mnt/playpen/mailwoman-data/wof/candidate-global-20h.db")
const N = Number(arg("n", "150"))
// Same-harness confirm (#780): also grade Nominatim on the same rows + grading, so mailwoman-with-lever
// vs Nominatim is apples-to-apples (no cross-harness baseline gap). Opt-in — the public API is rate-
// limited to ~1 req/s, so only run when explicitly confirming. Reuses #775's queryNominatim verbatim.
const NOM = process.argv.includes("--nominatim")
const NOMINATIM_UA = "mailwoman-eval/1.0 (https://mailwoman.sister.software)"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function queryNominatim(raw: string, cc: string): Promise<{ lat: number; lon: number } | null> {
	try {
		const u = new URL("https://nominatim.openstreetmap.org/search")
		u.searchParams.set("q", raw)
		u.searchParams.set("format", "jsonv2")
		u.searchParams.set("limit", "1")
		u.searchParams.set("countrycodes", cc.toLowerCase())
		const r = await fetch(u, { headers: { "User-Agent": NOMINATIM_UA } })
		if (!r.ok) return null
		const j = (await r.json()) as Array<{ lat: string; lon: string }>
		return j[0] ? { lat: Number(j[0].lat), lon: Number(j[0].lon) } : null
	} catch {
		return null
	}
}
const LOCALES: [string, string][] = [
	["IT", "data/eval/external/oa-it-coord-150.jsonl"],
	["PT", "data/eval/external/oa-pt-coord-150.jsonl"],
	["PL", "data/eval/external/oa-pl-coord-150.jsonl"],
	["AT", "data/eval/external/oa-at-coord-150.jsonl"],
	["CZ", "data/eval/external/oa-cz-coord-150.jsonl"],
	["FR", "data/eval/external/oa-fr-coord-150.jsonl"],
	["AU", "data/eval/external/oa-au-coord-150.jsonl"],
]


type N9 = { tag?: string; lat?: number; lon?: number; placeId?: string; children?: N9[] }
const RANK: Record<string, number> = { house_number: 5, street: 4, locality: 3, city: 3, region: 2, country: 1 }
/** Most-specific resolved coordinate in the tree (highest placetype rank with a real lat/lon). */
function bestCoord(roots: N9[]): { lat: number; lon: number } | null {
	let best: { lat: number; lon: number; rank: number } | null = null
	const stack = [...roots]
	while (stack.length) {
		const n = stack.pop()!
		if (n.placeId && typeof n.lat === "number" && typeof n.lon === "number" && (n.lat !== 0 || n.lon !== 0)) {
			const rank = RANK[n.tag ?? ""] ?? 0
			if (!best || rank > best.rank) best = { lat: n.lat, lon: n.lon, rank }
		}
		if (n.children?.length) stack.push(...n.children)
	}
	return best ? { lat: best.lat, lon: best.lon } : null
}

interface Stat {
	n: number
	resBase: number
	res25Base: number
	resLever: number
	res25Lever: number
	nom25: number
}

async function main() {
	const { createScorer } = await import("@mailwoman/neural/scorer")
	const { WofCandidateTableLookup } = await import("@mailwoman/resolver-wof-sqlite")
	const backend = new WofCandidateTableLookup({ databasePath: CAND })
	const resolver = createWofResolver(backend as never)
	const model = await createScorer({
		modelPath: MODEL,
		tokenizerPath: TOK,
		modelCardPath: CARD,
		anchorLookupPath: ANCHOR,
		strict: true,
		tier: "server",
	})

	console.log(`loc |  n  | @25km% base → lever${NOM ? " | nominatim" : ""}`)
	const T: Stat = { n: 0, resBase: 0, res25Base: 0, resLever: 0, res25Lever: 0, nom25: 0 }
	for (const [cc, file] of LOCALES) {
		if (!existsSync(file)) continue
		const rows = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.slice(0, N)
			.map((l) => JSON.parse(l))
		const s: Stat = { n: 0, resBase: 0, res25Base: 0, resLever: 0, res25Lever: 0, nom25: 0 }
		for (const row of rows) {
			const tLat = Number(row.lat),
				tLon = Number(row.lon)
			if (!Number.isFinite(tLat) || !Number.isFinite(tLon)) continue
			s.n++
			const tree = await model.parse(row.raw, { postcodeRepair: true })
			// resolveTree decorates nodes in place — clone so the two configs are independent.
			const base = await resolver.resolveTree(structuredClone(tree) as never, { defaultCountry: cc })
			const lever = await resolver.resolveTree(structuredClone(tree) as never, {
				defaultCountry: cc,
				spanRescore: true,
			})
			const cB = bestCoord((base.roots as N9[]) ?? [])
			const cL = bestCoord((lever.roots as N9[]) ?? [])
			if (cB) {
				s.resBase++
				if (haversineKm(tLat, tLon, cB.lat, cB.lon) <= 25) s.res25Base++
			}
			if (cL) {
				s.resLever++
				if (haversineKm(tLat, tLon, cL.lat, cL.lon) <= 25) s.res25Lever++
			}
			if (NOM) {
				const cN = await queryNominatim(row.raw, cc)
				if (cN && haversineKm(tLat, tLon, cN.lat, cN.lon) <= 25) s.nom25++
				await sleep(1100) // Nominatim ~1 req/s policy
			}
		}
		const pct = (x: number) => `${((100 * x) / Math.max(s.n, 1)).toFixed(0)}%`
		console.log(
			`${cc.padEnd(3)} | ${String(s.n).padStart(3)} | ${pct(s.res25Base).padStart(4)} → ${pct(s.res25Lever).padStart(4)}${NOM ? ` | ${pct(s.nom25).padStart(4)}` : ""}`
		)
		for (const k of Object.keys(s) as (keyof Stat)[]) T[k] += s[k]
	}
	const p = (x: number) => ((100 * x) / Math.max(T.n, 1)).toFixed(1)
	console.log(
		`\n#370 span-rescore E2E (wired resolveTree, candidate gazetteer, coord-graded @25km, n=${T.n}):\n` +
			`   resolved:        baseline ${p(T.resBase)}% → spanRescore ${p(T.resLever)}%  (+${(Number(p(T.resLever)) - Number(p(T.resBase))).toFixed(1)}pp)\n` +
			`   right-place @25km: baseline ${p(T.res25Base)}% → spanRescore ${p(T.res25Lever)}%  (+${(Number(p(T.res25Lever)) - Number(p(T.res25Base))).toFixed(1)}pp)` +
			(NOM
				? `\n   SAME-HARNESS vs Nominatim @25km: mailwoman+lever ${p(T.res25Lever)}% vs Nominatim ${p(T.nom25)}%  (Δ ${(Number(p(T.res25Lever)) - Number(p(T.nom25))).toFixed(1)}pp)`
				: "") +
			`\n   → the production flag's real EU coordinate lift, end-to-end through resolveTree + the gate.`
	)
}
await main()
