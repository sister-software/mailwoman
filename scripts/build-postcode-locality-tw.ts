/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the TW postcode → WOF admin table by AUTHORITATIVE NAME + POLYGON BRIDGE (#473, unblocks
 *   #294 — Direction E / the CJK arena).
 *
 *   This is the Taiwan sibling of `build-postcode-locality-cjk.ts` (JP) and
 *   `build-postcode-locality-kr.ts` (KR). It emits the SAME `postcode_locality` table, so the
 *   existing `postcode_area_resolution` resolver strategy consumes it unchanged — one strategy,
 *   many builds. TW's data shape differs from both siblings:
 *
 *   - Overture's addresses theme carries ZERO postcodes for TW (0/9,732,009 on release 2026-06-17.0,
 *       re-verified after the 2026-05-20.0 probe on #473 — the issue's original "group Overture by
 *       postcode" plan is structurally impossible), and GeoNames has NO TW postal file (the original
 *       #294 blocker). The keying source is therefore the national postal authority directly:
 *       Chunghwa Post's 3-digit postal-code → administrative-district table WITH official district
 *       center coordinates (data.gov.tw dataset 25489, `1050812_行政區經緯度(toPost).xml`, OGDL v1).
 *   - The 3-digit code IS the admin-granularity key: TW's "3+3" system appends a road-segment /
 *       delivery-point tail below district level (and the full 3+3 file is account-gated at
 *       fpp.post.gov.tw since 2025). A resolver that answers "which district" needs exactly the
 *       3-digit table. Queries carrying a full 3+3 code need a prefix-truncation normalization
 *       upstream (noted on #473; not this table's concern).
 *   - NAME-ONLY matching (the JP/KR recipe) tops out at 63% here: WOF models TW districts across
 *       `county` (direct-municipality districts), `localadmin`, and `locality`, and the `county`
 *       rows carry NO Chinese names at all (eng/fra only — verified against both admin-tw.db and
 *       the shipped admin-global-priority.db). The bridge is GEOMETRIC instead: the postal row's
 *       official district center → the Overture `divisions` district polygon that contains it
 *       (Chinese full-form names, fetched release-pinned by `scripts/eval/
 *       fetch-tw-division-polygons.ts`) → the WOF district-tier row whose point falls inside that
 *       polygon. Real containment, no romanization guesswork.
 *
 *   Match target: our custom-built admin-tw.db (from the whosonfirst-data-admin-tw GeoJSON repo via
 *   scripts/build-unified-wof.ts — WOF ids identical to the shipped admin-global-priority.db, so
 *   the table works attached beside either).
 *
 *   Output rows: `is_containing=1` for the polygon-confirmed district row, plus up to NEARBY_KEEP
 *   nearby non-containing candidates for the soft-score set, same tiering semantics as the JP/KR
 *   builders. `aliases` carries the Chinese forms (full 行政區名, bare district, 台-variant) so
 *   `softNameScore` can match CJK query text against the romanized canonical name.
 *
 *   Build-then-move: the table is written to `<output>.building` and renamed into place on success,
 *   so the destination is never a half-built artifact.
 *
 *   Usage: node scripts/build-postcode-locality-tw.ts\
 *   --postal-xml $MAILWOMAN_DATA_ROOT/tw-postal/district-centroids.xml\
 *   --divisions $MAILWOMAN_DATA_ROOT/overture/2026-06-17.0/divisions-tw-admin.jsonl\
 *   --admin-db $MAILWOMAN_DATA_ROOT/wof/dbs-per-country/admin-tw.db\
 *   --output $MAILWOMAN_DATA_ROOT/wof/postcode-locality-tw.db
 */

import { readFileSync, realpathSync, renameSync, rmSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { sealDatabase } from "@mailwoman/core/utils"
import { geometryContains, type GeojsonGeometry } from "@mailwoman/resolver-wof-sqlite/geo"

const NEARBY_KEEP = 2 // extra non-containing candidates kept for the soft-score set (JP/KR precedent)
const FALLBACK_RADIUS_KM = 20.0 // no-polygon fallback: name+proximity net around the official center
/**
 * Cross-placetype spread, one wider than JP/KR: TW districts land on `county` (direct-municipality districts),
 * `localadmin`, `locality` (county-administered townships/cities), AND `neighbourhood` (the Kaohsiung/Taichung inner
 * districts — 前金/苓雅/三民/… are `neighbourhood` in WOF). Neighbourhood rows are only ever accepted NAME-GATED (their
 * Chinese name must match the postal district), never as bare geometric fallback — 1,450 TW neighbourhoods would
 * otherwise swallow the district tier.
 */
const PLACETYPES = ["locality", "county", "localadmin", "borough", "neighbourhood"] as const
/** District-tier placetypes — the rows that ARE the 區/鄉/鎮/市 tier when present inside the polygon. */
const DISTRICT_TIER = new Set(["county", "localadmin"])
const DISTRICT_SUFFIX = /[區鄉鎮市]$/

/** The county/city prefix (直轄市/縣/市) is always exactly 3 characters (371/371 rows verified). */
const COUNTY_PREFIX_LENGTH = 3

/** Fold the 臺/台 orthographic variants (both are current; sources disagree row-by-row). */
export function normHan(s: string): string {
	return s
		.normalize("NFC")
		.replace(/臺/g, "台")
		.replace(/[\s　-]/g, "")
}

/**
 * Romanized-name stem: lowercase, diacritics stripped, tier suffix words dropped — so Overture's "Wanhua District"
 * meets WOF's "Wanhua", and WOF's "Lingya Village" (a mislabeled district) meets "Lingya District".
 */
export function normEn(s: string): string {
	return (
		s
			.normalize("NFKD")
			.replace(/\p{M}/gu, "")
			.toLowerCase()
			// `qu`/`xiang`/`zhen` are the romanized 區/鄉/鎮 suffixes WOF sometimes carries ("Zhongzheng Qu").
			.replace(/\s+(district|township|city|county|village|islands?|qu|xiang|zhen)$/g, "")
			.replace(/[\s'’-]/g, "")
	)
}

function toRad(deg: number): number {
	return (deg * Math.PI) / 180
}

/** Haversine distance in km (asin form — same as the JP/KR builders). */
function haversineKm(aLat: number, bLon: number, cLat: number, dLon: number): number {
	const R = 6371.0
	const p1 = toRad(aLat)
	const p2 = toRad(cLat)
	const dp = toRad(cLat - aLat)
	const dl = toRad(dLon - bLon)

	return 2 * R * Math.asin(Math.sqrt(Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2))
}

/** UTC ISO-8601 to the second. */
function isoSeconds(): string {
	return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00")
}

export interface PostalDistrict {
	/** Full 行政區名, e.g. 臺北市中正區. */
	name: string
	/** County/city prefix (exactly 3 chars), e.g. 臺北市. */
	county: string
	/** District remainder, e.g. 中正區. */
	district: string
	/** 3-digit postal code (the admin-granularity key). */
	postcode: string
	lat: number
	lon: number
}

/**
 * Parse Chunghwa Post's `行政區經緯度(toPost).xml` (data.gov.tw dataset 25489). The document is flat and regular; entries
 * carry 行政區名 / 3碼郵遞區號 / 中心點經度 / 中心點緯度.
 */
export function loadPostalDistricts(path: string): PostalDistrict[] {
	const xml = readFileSync(path, "utf8")
	const re =
		/<行政區名>([^<]+)<\/行政區名>\s*<_x0033_碼郵遞區號>(\d+)<\/_x0033_碼郵遞區號>\s*<中心點經度>([\d.]+)<\/中心點經度>\s*<中心點緯度>([\d.]+)<\/中心點緯度>/g
	const out: PostalDistrict[] = []

	for (const m of xml.matchAll(re)) {
		const name = m[1]!.trim()
		const lat = Number(m[4])
		const lon = Number(m[3])

		if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
		out.push({
			name,
			county: name.slice(0, COUNTY_PREFIX_LENGTH),
			district: name.slice(COUNTY_PREFIX_LENGTH),
			postcode: m[2]!,
			lat,
			lon,
		})
	}

	return out
}

export interface DivisionPolygon {
	/** Overture names.primary (Chinese full form, e.g. 萬華區). */
	name: string
	nameHan: string
	/**
	 * Overture's English name ("Wanhua District") — the data-backed romanization bridge to WOF rows that carry no Chinese
	 * names (the whole `county` tier + the Kaohsiung `neighbourhood` districts).
	 */
	nameEn: string | null
	/** Wikidata QID from the joined `division` row — the principled WOF-concordance bridge. */
	wikidata: string | null
	geometry: GeojsonGeometry
	bbox: [number, number, number, number] // minLon, minLat, maxLon, maxLat
}

/** Load the district polygons fetched from the Overture divisions theme (subtype=locality slice). */
export function loadDistrictPolygons(path: string): DivisionPolygon[] {
	const out: DivisionPolygon[] = []

	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue
		const row = JSON.parse(line) as {
			subtype: string
			name: string
			name_en?: string | null
			wikidata?: string | null
			geometry: string | GeojsonGeometry
		}

		if (row.subtype !== "locality") continue
		// DuckDB's JSON writer emits ST_AsGeoJSON output as a nested JSON object; tolerate a string too.
		const geometry = (typeof row.geometry === "string" ? JSON.parse(row.geometry) : row.geometry) as GeojsonGeometry
		let minLon = Infinity
		let minLat = Infinity
		let maxLon = -Infinity
		let maxLat = -Infinity
		const scan = (coords: unknown): void => {
			if (Array.isArray(coords) && typeof coords[0] === "number") {
				const [lon, lat] = coords as [number, number]

				if (lon < minLon) {
					minLon = lon
				}

				if (lon > maxLon) {
					maxLon = lon
				}

				if (lat < minLat) {
					minLat = lat
				}

				if (lat > maxLat) {
					maxLat = lat
				}

				return
			}

			if (Array.isArray(coords)) {
				for (const c of coords) {
					scan(c)
				}
			}
		}
		scan((geometry as { coordinates?: unknown }).coordinates)
		out.push({
			name: row.name,
			nameHan: normHan(row.name),
			nameEn: row.name_en ?? null,
			wikidata: row.wikidata ?? null,
			geometry,
			bbox: [minLon, minLat, maxLon, maxLat],
		})
	}

	return out
}

interface Args {
	postalXml: string
	divisions: string
	adminDb: string
	output: string
}

function parseCLIArgs(): Args {
	const { values } = parseArgs({
		options: {
			"postal-xml": { type: "string" },
			divisions: { type: "string" },
			"admin-db": { type: "string" },
			output: { type: "string" },
		},
	})

	if (!values["postal-xml"] || !values.divisions || !values["admin-db"] || !values.output) {
		console.error(
			"Usage: build-postcode-locality-tw.ts --postal-xml <行政區經緯度.xml> --divisions <divisions-tw-admin.jsonl> --admin-db <admin-tw.db> --output <db>"
		)
		process.exit(2)
	}

	return {
		postalXml: values["postal-xml"],
		divisions: values.divisions,
		adminDb: values["admin-db"],
		output: values.output,
	}
}

interface AdminPlace {
	pid: number
	/** Canonical (romanized) spr name. */
	nm: string
	placetype: string
	la: number
	lo: number
	/** NormHan'd Chinese name forms from the names table (empty for the county tier — see header). */
	hanNames: Set<string>
	/** NormEn'd romanized stems (canonical spr.name + eng names) — matched against Overture's en name. */
	engNames: Set<string>
}

async function main(): Promise<void> {
	const args = parseCLIArgs()
	const districts = loadPostalDistricts(args.postalXml)

	if (districts.length === 0) {
		console.error(`no postal districts parsed from ${args.postalXml}`)
		process.exit(1)
	}
	const polygons = loadDistrictPolygons(args.divisions)
	const polygonsByName = new Map<string, DivisionPolygon[]>()

	for (const p of polygons) {
		const bucket = polygonsByName.get(p.nameHan)

		if (bucket) {
			bucket.push(p)
		} else {
			polygonsByName.set(p.nameHan, [p])
		}
	}

	const admin = new DatabaseSync(args.adminDb)
	const ph = PLACETYPES.map(() => "?").join(",")
	const places = new Map<number, AdminPlace>()

	for (const row of admin
		.prepare(
			`SELECT id, name, placetype, latitude, longitude FROM spr WHERE country='TW' AND placetype IN (${ph})
			 AND latitude IS NOT NULL AND NOT (latitude=0 AND longitude=0)`
		)
		.all(...PLACETYPES) as Array<{
		id: number
		name: string
		placetype: string
		latitude: number
		longitude: number
	}>) {
		places.set(row.id, {
			pid: row.id,
			nm: row.name,
			placetype: row.placetype,
			la: row.latitude,
			lo: row.longitude,
			hanNames: new Set(),
			engNames: new Set([normEn(row.name)]),
		})
	}

	// Chinese name forms (zho + Han-bearing und) and romanized eng variants; canonical spr.name is romanized.
	for (const row of admin
		.prepare(
			`SELECT n.id, n.name, n.language FROM names n JOIN spr s ON s.id = n.id
			 WHERE s.country='TW' AND s.placetype IN (${ph}) AND n.language IN ('zho','und','eng')`
		)
		.all(...PLACETYPES) as Array<{ id: number; name: string; language: string }>) {
		const place = places.get(row.id)

		if (!place) continue

		if (/[一-鿿]/.test(row.name)) {
			place.hanNames.add(normHan(row.name))
		} else if (row.language === "eng") {
			place.engNames.add(normEn(row.name))
		}
	}

	// Region tier (the 22 直轄市/縣/市) — the containing-city fallback for districts WOF simply lacks
	// (Kaohsiung 三民/鹽埕, the Taichung/Tainan directional districts, the offshore islands). Keyed by
	// normHan'd Chinese name, matched against the postal county prefix.
	const regionsByHan = new Map<string, AdminPlace>()

	for (const row of admin
		.prepare(
			`SELECT s.id, s.name, s.latitude, s.longitude, n.name AS han FROM spr s
			 JOIN names n ON n.id = s.id AND n.language IN ('zho','und')
			 WHERE s.country='TW' AND s.placetype='region' AND s.latitude IS NOT NULL`
		)
		.all() as Array<{ id: number; name: string; latitude: number; longitude: number; han: string }>) {
		if (!/[一-鿿]/.test(row.han)) continue
		regionsByHan.set(normHan(row.han), {
			pid: row.id,
			nm: row.name,
			placetype: "region",
			la: row.latitude,
			lo: row.longitude,
			hanNames: new Set([normHan(row.han)]),
			engNames: new Set([normEn(row.name)]),
		})
	}

	// Wikidata concordances — the bridge for districts whose WOF point sits OUTSIDE its own polygon
	// (Wanhua's is ~5 km west) and whose `county`-tier row carries no Chinese names to match on.
	const placesByQID = new Map<string, AdminPlace[]>()

	for (const row of admin
		.prepare(
			`SELECT c.id, c.other_id AS qid FROM concordances c JOIN spr s ON s.id = c.id
			 WHERE c.other_source='wd:id' AND s.country='TW' AND s.placetype IN (${ph})`
		)
		.all(...PLACETYPES) as Array<{ id: number; qid: string }>) {
		const place = places.get(row.id)

		if (!place) continue
		const bucket = placesByQID.get(row.qid)

		if (bucket) {
			bucket.push(place)
		} else {
			placesByQID.set(row.qid, [place])
		}
	}
	admin.close()

	// Proximity grid (0.5° cells, same shape as the JP/KR builders) — used by both the polygon
	// candidate scan (bbox-scoped) and the no-polygon fallback.
	const grid = new Map<string, AdminPlace[]>()

	for (const p of places.values()) {
		const key = `${Math.round(p.lo * 2)}|${Math.round(p.la * 2)}`
		const bucket = grid.get(key)

		if (bucket) {
			bucket.push(p)
		} else {
			grid.set(key, [p])
		}
	}

	const nearby = (lat: number, lon: number, radiusKm: number): Array<{ d: number; place: AdminPlace }> => {
		const cx = Math.round(lon * 2)
		const cy = Math.round(lat * 2)
		const out: Array<{ d: number; place: AdminPlace }> = []

		for (const dx of [-1, 0, 1]) {
			for (const dy of [-1, 0, 1]) {
				for (const place of grid.get(`${cx + dx}|${cy + dy}`) ?? []) {
					const d = haversineKm(lat, lon, place.la, place.lo)

					if (d <= radiusKm) {
						out.push({ d, place })
					}
				}
			}
		}
		out.sort((a, b) => a.d - b.d || a.place.pid - b.place.pid)

		return out
	}

	const buildPath = `${args.output}.building`
	rmSync(buildPath, { force: true })
	const db = new DatabaseSync(buildPath)
	const kdb = new DatabaseClient({ database: db })
	await kdb.schema
		.createTable("postcode_locality")
		.addColumn("postcode", "text", (c) => c.notNull())
		.addColumn("country", "text", (c) => c.notNull())
		.addColumn("locality_id", "integer", (c) => c.notNull())
		.addColumn("locality_name", "text", (c) => c.notNull())
		.addColumn("aliases", "text")
		.addColumn("distance_km", "real", (c) => c.notNull())
		.addColumn("is_containing", "integer", (c) => c.notNull())
		.execute()

	const rows: Array<[string, string, number, string, string, number, number]> = []
	const tierCounts = { polygon: 0, wikidata: 0, name_in_polygon: 0, name_nearby: 0, region_fallback: 0 }
	const unmatched: string[] = []

	for (const d of districts) {
		const districtHan = normHan(d.district)
		const stemHan = districtHan.replace(DISTRICT_SUFFIX, "")
		const aliases = [d.name, d.district, normHan(d.name) !== d.name ? normHan(d.name) : ""].filter(Boolean).join("|")
		const hanMatches = (p: AdminPlace): boolean =>
			p.hanNames.has(districtHan) || (stemHan.length >= 2 && p.hanNames.has(stemHan))
		// The Overture en name is per-polygon, so the closure is (re)bound after the polygon resolves.
		let enStem = ""
		const nameMatches = (p: AdminPlace): boolean => hanMatches(p) || (enStem.length >= 3 && p.engNames.has(enStem))

		// 1. The district polygon: name match (full Chinese form), disambiguated by whether it contains
		//    the OFFICIAL district center (中正區 exists in both Taipei and Keelung; each official
		//    center falls in exactly its own polygon).
		const namesakes = polygonsByName.get(districtHan) ?? []
		const polygon =
			namesakes.length === 1 ? namesakes[0] : namesakes.find((p) => geometryContains(p.geometry, d.lon, d.lat) === true)

		// 2. The WOF row, tiered:
		//    a. district-tier (county/localadmin) point inside the polygon — real containment;
		//    b. wikidata concordance (division.wikidata ↔ WOF wd:id) — identity survives a sloppy WOF
		//       point that fell outside its own polygon;
		//    c. Chinese-name match inside the polygon (locality/neighbourhood tiers);
		//    d. no-polygon fallback: JP/KR-style authoritative-name + proximity net.
		let hit: { d: number; place: AdminPlace } | undefined
		let extras: Array<{ d: number; place: AdminPlace }> = []

		if (polygon) {
			enStem = polygon.nameEn ? normEn(polygon.nameEn) : ""
			const [minLon, minLat, maxLon, maxLat] = polygon.bbox
			const inside: Array<{ d: number; place: AdminPlace }> = []

			for (const p of places.values()) {
				if (p.lo < minLon || p.lo > maxLon || p.la < minLat || p.la > maxLat) continue

				if (geometryContains(polygon.geometry, p.lo, p.la) !== true) continue
				inside.push({ d: haversineKm(d.lat, d.lon, p.la, p.lo), place: p })
			}
			inside.sort((a, b) => a.d - b.d || a.place.pid - b.place.pid)

			// Name-confirmed district-tier first: sloppy WOF points put a NEIGHBORING district's row
			// inside this polygon (Zhongshan's point sits in 中正區), so bare containment alone picks
			// the wrong namesake when both are inside. Bare containment stays as the in-tier backup and
			// OUTRANKS the wikidata bridge — measured, not assumed: promoting wd above bare containment
			// dropped eval PIP 86.4→85.2% (2026-07-02, n=3000 seed 42), because WOF's TW wd
			// concordances are themselves misattached (890468273 "Zhongzheng Qu" carries KEELUNG's
			// Q712871 while its point sits in Taipei). A point inside the polygon is at least
			// coordinate-correct; a wrong-side concordance is wrong everywhere.
			hit =
				inside.find((c) => DISTRICT_TIER.has(c.place.placetype) && nameMatches(c.place)) ??
				inside.find((c) => DISTRICT_TIER.has(c.place.placetype))

			if (hit) {
				tierCounts.polygon++
			} else if (polygon.wikidata) {
				const concordant = (placesByQID.get(polygon.wikidata) ?? [])
					.map((place) => ({ d: haversineKm(d.lat, d.lon, place.la, place.lo), place }))
					.sort(
						(a, b) =>
							Number(!DISTRICT_TIER.has(a.place.placetype)) - Number(!DISTRICT_TIER.has(b.place.placetype)) || a.d - b.d
					)
				hit = concordant[0]

				if (hit) {
					tierCounts.wikidata++
				}
			}

			if (!hit) {
				// Chinese or Overture-en name match inside the polygon — the romanization bridge for the
				// zho-less `county`/`neighbourhood` rows (Lingya, Qianzhen, …).
				hit = inside.find((c) => nameMatches(c.place))

				if (hit) {
					tierCounts.name_in_polygon++
				}
			}

			if (hit) {
				extras = inside.filter((c) => c.place.pid !== hit!.place.pid)
			}
		}

		if (!hit) {
			// No polygon (or nothing usable in it): the JP/KR-style authoritative-name + proximity net.
			// The en stem also rescues district rows whose WOF point fell OUTSIDE their own polygon
			// (Wanhua sits ~5 km west of 萬華區, in New Taipei). Neighbourhood rows only qualify through
			// the name gate, never by bare proximity — see the PLACETYPES note.
			const cands = nearby(d.lat, d.lon, FALLBACK_RADIUS_KM)
			const districtTierNameHit = cands.find((c) => DISTRICT_TIER.has(c.place.placetype) && nameMatches(c.place))
			const nameHit = districtTierNameHit ?? cands.find((c) => nameMatches(c.place))

			if (nameHit) {
				tierCounts.name_nearby++
				hit = nameHit
				extras = cands.filter((c) => c.place.pid !== nameHit.place.pid && c.place.placetype !== "neighbourhood")
			} else {
				// 5. Containing-city (region) fallback: WOF has NO row for this district at all (the
				//    Kaohsiung/Taichung/Tainan urban-core gaps, the offshore islands). The county-prefix
				//    region row is a TRUE container — coarser granularity, honestly recorded (the meta
				//    counts it separately), and the city coordinate beats a wrong-district neighbor.
				const region = regionsByHan.get(normHan(d.county))
				unmatched.push(d.name)

				if (region) {
					tierCounts.region_fallback++
					const dist = haversineKm(d.lat, d.lon, region.la, region.lo)
					rows.push([d.postcode, "TW", region.pid, region.nm, aliases, Math.round(dist * 1000) / 1000, 1])
					const weak = cands.find((c) => c.place.placetype !== "neighbourhood")

					if (weak) {
						rows.push([d.postcode, "TW", weak.place.pid, weak.place.nm, aliases, Math.round(weak.d * 1000) / 1000, 0])
					}
				} else {
					const weak = cands.find((c) => c.place.placetype !== "neighbourhood")

					if (weak) {
						// Weak candidate only — recorded non-containing so the resolver's soft score treats it
						// as proximity evidence, never as an authoritative containment.
						rows.push([d.postcode, "TW", weak.place.pid, weak.place.nm, aliases, Math.round(weak.d * 1000) / 1000, 0])
					}
				}
				continue
			}
		}

		rows.push([d.postcode, "TW", hit.place.pid, hit.place.nm, aliases, Math.round(hit.d * 1000) / 1000, 1])
		let kept = 0

		for (const c2 of extras) {
			rows.push([d.postcode, "TW", c2.place.pid, c2.place.nm, aliases, Math.round(c2.d * 1000) / 1000, 0])

			if (++kept >= NEARBY_KEEP) break
		}
	}

	const insert = db.prepare("INSERT INTO postcode_locality VALUES (?,?,?,?,?,?,?)")
	db.exec("BEGIN")

	for (const r of rows) {
		insert.run(...r)
	}
	db.exec("COMMIT")

	await kdb.schema
		.createIndex("postcode_locality_by_pc")
		.on("postcode_locality")
		.columns(["postcode", "country"])
		.execute()

	await kdb.schema
		.createTable("meta")
		.addColumn("key", "text", (c) => c.primaryKey())
		.addColumn("value", "text")
		.execute()
	const matched = tierCounts.polygon + tierCounts.wikidata + tierCounts.name_in_polygon + tierCounts.name_nearby
	const matchRate = `${((100 * matched) / districts.length).toFixed(1)}%`
	const meta: Array<[string, string]> = [
		["name", "mailwoman-postcode-locality-tw"],
		["description", "TW 3-digit postcode -> WOF district via official center + Overture division polygon bridge"],
		[
			"method",
			"Chunghwa Post district table (official centers) -> containing Overture division polygon -> WOF row, tiered: " +
				"district-tier-inside > wikidata concordance > Chinese-name-inside > JP/KR-style name+proximity fallback",
		],
		[
			"source",
			"Chunghwa Post 行政區經緯度(toPost).xml via data.gov.tw dataset 25489 (OGDL v1) + Overture divisions " +
				"2026-06-17.0 (district polygons) + custom-built admin-tw.db (whosonfirst-data-admin-tw); built from source. " +
				"Overture addresses 2026-06-17.0 carries 0 TW postcodes (verified) — the postal authority table is the " +
				"only keying source. The 3+3 tail is road-segment granularity (below admin; full file account-gated at " +
				"fpp.post.gov.tw); this table keys the 3-digit admin code.",
		],
		["country", "TW"],
		["postcodes_total", String(districts.length)],
		["postcodes_matched", String(matched)],
		["postcodes_by_tier", JSON.stringify(tierCounts)],
		["match_rate", matchRate],
		["unmatched", unmatched.join("|") || "(none)"],
		["built_at", isoSeconds()],
	]
	const insMeta = db.prepare("INSERT OR REPLACE INTO meta VALUES (?,?)")

	for (const [k, v] of meta) {
		insMeta.run(k, v)
	}

	db.exec("PRAGMA journal_mode=DELETE")
	db.exec("ANALYZE")
	const ok = (db.prepare("PRAGMA integrity_check").get() as Record<string, string>)["integrity_check"]

	if (ok !== "ok") {
		console.error(`integrity_check failed: ${ok}`)
		process.exit(1)
	}
	db.exec("VACUUM")
	db.close()
	// Build-then-move: the destination only ever sees a fully-built, integrity-checked artifact.
	renameSync(buildPath, args.output)
	// The sealed-artifact invariant: a built DB is a read-only asset from the moment it exists.
	sealDatabase(args.output)
	console.log(
		`TW: ${districts.length} postal districts, ${matched} matched (${matchRate}; tiers ${JSON.stringify(tierCounts)}), ` +
			`${rows.length} rows -> ${args.output}` +
			(unmatched.length ? `\n  unmatched: ${unmatched.join(", ")}` : "")
	)
}

// Run main() only when invoked directly (import-safe, same guard as the sibling builders).
const selfPath = realpathSync(fileURLToPath(import.meta.url))
const entryPath = process.argv[1] ? realpathSync(process.argv[1]) : ""

if (entryPath && entryPath === selfPath) {
	await main()
}
