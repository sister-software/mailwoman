import { existsSync, readFileSync } from "node:fs"

/**
 * @copyright Sister Software · @license AGPL-3.0 · @author Teffen Ellis, et al.
 *
 *   EU qualified-name recall (#734 "measure first" + the #370 connection).
 *
 *   Two separate investigations this shift converged on one root cause: OpenAddresses writes a
 *   locality in its DISAMBIGUATED / qualified form while the gazetteer holds the base name. #734 saw
 *   it in candidate-table recall (`Hart b.Graz`, `Roche VD`, `Lenk im Simmental`, `Santa Eulália Viz`,
 *   `Nogueira Do Cravo Ohp`); #370 saw the same shape in the span-rescore swap tail. The #734 issue's
 *   proposed lever — "a base-name aliasing/parse heuristic (split on `/`, ` b.`, trailing region
 *   codes) — collision-risky, MEASURE FIRST." This is the measurement.
 *
 *   For each EU coord-golden row, take the gold locality and:
 *     1. Exact-match the candidate gazetteer (country-constrained). Baseline recall.
 *     2. For a MISS, apply base-name normalization and re-match.
 *     3. Coordinate-grade the recovery (#566): the recovered place's coord must land ≤25 km from the
 *        row's truth point. A near hit is a genuine recovery; a far hit is a same-name COLLISION (the
 *        normalization stripped too much and matched a different place). Grading the string alone
 *        would call both a "win" — the whole point of #734's "measure first" is the collision rate.
 *
 *   Two normalization tiers, measured separately because their risk differs sharply:
 *     - STRUCTURAL (low-risk): strip `/X`, ` b.X` (bei), ` im/an der/ob der/a.d. X`. These are
 *       unambiguous Austrian/Swiss/German disambiguation suffixes; the base token is intact.
 *     - TRAILING-TOKEN (risky): also strip a trailing short capitalized token (`VD`, `S`, `Viz`,
 *       `Ohp`). This recovers `Roche VD` but can also eat a real name part (`Santa Cruz` → `Santa`).
 *
 *   Run: node --experimental-strip-types scripts/eval/eu-qualified-name-recall.ts [--n 150]
 */
import { dataRootPath } from "@mailwoman/core/utils"
import { haversineKm } from "@mailwoman/spatial"

import { arg } from "../lib/cli-args.ts"

const N = Number(arg("n", "150"))
const CAND = arg("candidate-db", dataRootPath("wof", "candidate-global-20h.db"))
const GATE_KM = Number(arg("gate", "25"))
const LOCALES: [string, string][] = [
	["IT", "data/eval/external/oa-it-coord-150.jsonl"],
	["PT", "data/eval/external/oa-pt-coord-150.jsonl"],
	["PL", "data/eval/external/oa-pl-coord-150.jsonl"],
	["AT", "data/eval/external/oa-at-coord-150.jsonl"],
	["CZ", "data/eval/external/oa-cz-coord-150.jsonl"],
	["FR", "data/eval/external/oa-fr-coord-150.jsonl"],
	["AU", "data/eval/external/oa-au-coord-150.jsonl"],
]

const norm = (s: string): string =>
	s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9 ]/g, " ")
		.replace(/\s+/g, " ")
		.trim()

/** Strip the unambiguous structural disambiguation suffixes (low-risk). */
const baseStructural = (s: string): string =>
	s
		.replace(/\/.*$/, "") // Kraubath/Mur → Kraubath
		.replace(/\s+b\.?\s*\S.*$/i, "") // Hart b.Graz → Hart  (bei)
		.replace(/\s+(im|in der|an der|ob der|am|a\.\s*d\.?)\s+\S.*$/i, "") // Lenk im Simmental → Lenk
		.trim()
/** Additionally strip a trailing short capitalized token (risky — can eat a real name part). */
const baseTrailingToken = (s: string): string =>
	baseStructural(s)
		.replace(/\s+[A-ZÀ-Þ][a-zà-þ]{0,2}\.?$/u, "") // Roche VD → Roche ; Santa Eulália Viz → Santa Eulália
		.trim()

interface Cand {
	name: string
	lat: number
	lon: number
	exactMatch?: boolean
}
interface Lookup {
	findPlace(q: { text: string; country?: string; limit?: number }): Promise<Cand[]>
}

async function exactNear(
	lookup: Lookup,
	text: string,
	cc: string,
	tLat: number,
	tLon: number
): Promise<{ hit: boolean; near: boolean; km: number }> {
	const key = norm(text)

	if (key.length < 2) return { hit: false, near: false, km: NaN }
	const hits = await lookup.findPlace({ text, country: cc, limit: 5 })
	const exact = hits.filter((h) => h.exactMatch && norm(h.name) === key && (h.lat !== 0 || h.lon !== 0))

	if (!exact.length) return { hit: false, near: false, km: NaN }
	// nearest exact candidate to truth — the resolver's postcode anchor would pick this one
	const km = Math.min(...exact.map((h) => haversineKm(tLat, tLon, h.lat, h.lon)))

	return { hit: true, near: km <= GATE_KM, km }
}

async function main() {
	const { WofCandidateTableLookup } = await import("@mailwoman/resolver-wof-sqlite")
	const lookup = new WofCandidateTableLookup({ databasePath: CAND }) as unknown as Lookup

	console.log(`loc |  n  | base  | +struct (near/coll) | +trailtok (near/coll)`)
	const T = { n: 0, base: 0, sNear: 0, sColl: 0, tNear: 0, tColl: 0 }

	for (const [cc, file] of LOCALES) {
		if (!existsSync(file)) continue
		const rows = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.slice(0, N)
			.map((l) => JSON.parse(l))
		const s = { n: 0, base: 0, sNear: 0, sColl: 0, tNear: 0, tColl: 0 }

		for (const row of rows) {
			const gold = ((row.components?.locality as string) ?? "").toString().trim()
			const tLat = Number(row.lat),
				tLon = Number(row.lon)

			if (!gold || !Number.isFinite(tLat) || !Number.isFinite(tLon)) continue
			s.n++
			const base = await exactNear(lookup, gold, cc, tLat, tLon)

			if (base.hit) {
				s.base++
				continue // already recalled — normalization not needed
			}
			// Tier 1: structural normalization
			const struct = baseStructural(gold)

			if (norm(struct) !== norm(gold)) {
				const r = await exactNear(lookup, struct, cc, tLat, tLon)

				if (r.hit) {
					if (r.near) s.sNear++
					else s.sColl++
					continue
				}
			}
			// Tier 2: + trailing-token (only if structural didn't recover)
			const tok = baseTrailingToken(gold)

			if (norm(tok) !== norm(gold)) {
				const r = await exactNear(lookup, tok, cc, tLat, tLon)

				if (r.hit) {
					if (r.near) s.tNear++
					else s.tColl++

					if (process.env.DEBUG)
						console.error(`  [${cc}] ${r.near ? "RECOVER" : "COLLIDE"}: "${gold}" → "${tok}" (${r.km.toFixed(0)}km)`)
				}
			}
		}
		console.log(
			`${cc.padEnd(3)} | ${String(s.n).padStart(3)} | ${String(s.base).padStart(3)}=${((100 * s.base) / Math.max(s.n, 1)).toFixed(0)}% | ${String(s.sNear).padStart(2)} / ${String(s.sColl).padStart(2)}              | ${String(s.tNear).padStart(2)} / ${String(s.tColl).padStart(2)}`
		)

		for (const k of Object.keys(s) as (keyof typeof s)[]) T[k] += s[k]
	}
	const baseRecall = (100 * T.base) / Math.max(T.n, 1)
	const structRecall = (100 * (T.base + T.sNear)) / Math.max(T.n, 1)
	const allRecall = (100 * (T.base + T.sNear + T.tNear)) / Math.max(T.n, 1)
	console.log(
		`\nEU qualified-name recall (n=${T.n}, candidate gazetteer, coord-graded @${GATE_KM}km):\n` +
			`   baseline exact recall          = ${T.base} (${baseRecall.toFixed(1)}%)\n` +
			`   + structural (/  b.  im/an der) = +${T.sNear} near, ${T.sColl} collisions → ${structRecall.toFixed(1)}% (low-risk lever)\n` +
			`   + trailing-token (VD/S/Viz/Ohp) = +${T.tNear} near, ${T.tColl} collisions → ${allRecall.toFixed(1)}% (risky lever)\n` +
			`   → structural lever: ${T.sColl === 0 ? "ZERO collisions" : `${T.sColl} collisions`}, +${(structRecall - baseRecall).toFixed(1)}pp. ` +
			`trailing-token adds +${(allRecall - structRecall).toFixed(1)}pp at ${T.tColl}/${T.tNear + T.tColl} collision rate.`
	)
}
await main()
