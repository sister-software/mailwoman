import { readFileSync } from "node:fs"

/**
 * End-to-end JP resolver eval (#292): sample KEN_ALL postcodes, feed (city-or-ward text + postcode) to the real
 * backend, and check the resolved place name-agrees with KEN_ALL's authoritative municipality. Measures whether the
 * postcode actually carries the resolve to the right municipality through the coordinate-first path (vs an exact-name
 * tiering override). Gold = KEN_ALL (independent, authoritative).
 */
import { dataRootPath } from "@mailwoman/core/utils"
import { WOFSqlitePlaceLookup } from "@mailwoman/resolver-wof-sqlite"

const KENALL = dataRootPath("KEN_ALL_ROME", "KEN_ALL_ROME.CSV")
const backend = new WOFSqlitePlaceLookup({
	databasePath: [dataRootPath("wof", "admin-global-priority.db"), dataRootPath("wof", "postcode-locality-jp.db")],
})

function norm(s: string): string {
	return s
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[\s-]/g, "")
		.replace(/(shi|ku|cho|machi|gun|ken|fu|to|son|mura|ward)$/, "")
}
// KEN_ALL (CP932 → we read latin1 bytes; col6 romaji is ASCII so latin1 is safe for the romaji column)
const buf = readFileSync(KENALL, "latin1")
const rows: Array<{ pc: string; muni: string; city: string }> = []

for (const line of buf.split(/\r?\n/)) {
	const f = line.split(",").map((c) => c.replace(/^"|"$/g, ""))

	if (f.length >= 6 && /^\d{7}$/.test(f[0]!)) {
		const pc = `${f[0]!.slice(0, 3)}-${f[0]!.slice(3)}`
		const muni = f[5]!
		const city = muni.split(" ")[0] || muni // first token (the city / ward for Tokyo specials)
		rows.push({ pc, muni, city })
	}
}
// deterministic sample
const N = 2000
const step = Math.max(1, Math.floor(rows.length / N))
const sample = rows.filter((_, i) => i % step === 0).slice(0, N)

// Independent cross-check gold: GeoNames admin2 (sourced separately from KEN_ALL).
const gnAdmin2 = new Map<string, string>()

for (const line of readFileSync(dataRootPath("geonames", "JP.txt"), "utf8").split("\n")) {
	const f = line.split("\t")

	if (f.length > 5 && f[1]) {
		gnAdmin2.set(f[1]!, f[5]!)
	}
}

let resolved = 0
let agreeKen = 0
let crossN = 0
let crossAgree = 0

for (const r of sample) {
	const cands = await backend.findPlace({ text: r.city, placetype: "locality", postcode: r.pc, country: "JP" } as never)
	const top = cands[0]

	if (!top) continue
	resolved += 1
	const nm = norm(top.name)

	if (nm.length >= 2 && norm(r.muni).includes(nm)) {
		agreeKen += 1
	}
	const gn = gnAdmin2.get(r.pc)

	if (gn) {
		crossN += 1

		if (nm.length >= 2 && norm(gn).includes(nm)) {
			crossAgree += 1
		}
	}
}
console.log(`JP end-to-end (text=city token + postcode), n=${sample.length}:`)
console.log(`  resolved: ${resolved} (${((100 * resolved) / sample.length).toFixed(1)}%)`)
console.log(
	`  name-agree w/ KEN_ALL municipality (gold):   ${agreeKen} (${((100 * agreeKen) / sample.length).toFixed(1)}%)`
)
console.log(
	`  name-agree w/ GeoNames admin2 (independent): ${crossAgree}/${crossN} (${((100 * crossAgree) / crossN).toFixed(1)}%)`
)
backend.close?.()
process.exit(0)
