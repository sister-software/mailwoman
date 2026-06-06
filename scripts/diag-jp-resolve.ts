/**
 * Functional check for the JP KEN_ALL coarse resolution (#292). Wires the admin DB + the JP
 * postcode-locality shard and resolves a few known Japanese postcodes through the real backend's
 * coordinate-first path — confirms the authoritative-name-matched municipality actually wins.
 */
import { WofSqlitePlaceLookup } from "@mailwoman/resolver-wof-sqlite"

const WOF = [
	"/mnt/playpen/mailwoman-data/wof/admin-global-priority.db",
	"/mnt/playpen/mailwoman-data/wof/postcode-locality-jp.db",
]
const backend = new WofSqlitePlaceLookup({ databasePath: WOF })

// known postcode -> expected municipality/ward
const cases: Array<{ pc: string; text: string; expect: string }> = [
	// municipality-level text + postcode → the right ward, postcode disambiguating same-named wards
	{ pc: "104-0061", text: "Chuo", expect: "Chuo (Tokyo) — postcode picks Tokyo's Chuo" },
	{ pc: "060-0001", text: "Chuo", expect: "Chūō-ku (Sapporo) — SAME text, postcode picks Sapporo's" },
	{ pc: "530-0001", text: "Kita", expect: "Kita (Osaka) — postcode picks Osaka's Kita" },
	{ pc: "100-0001", text: "Chiyoda", expect: "Chiyoda (Tokyo)" },
	// OOD parse: text does NOT exact-match a fine place → the postcode must carry it to the municipality
	{ pc: "104-0061", text: "Tokyo Chuo ku", expect: "Chuo — postcode carries it" },
	{ pc: "530-0001", text: "Osaka", expect: "Kita (Osaka) — postcode carries past the bare city name" },
]
for (const c of cases) {
	const r = await backend.findPlace({ text: c.text, placetype: "locality", postcode: c.pc, country: "JP" } as never)
	const top = r[0] as any
	console.log(
		`${c.pc}  "${c.text}" -> ${top ? `${top.name} (score ${top.score?.toFixed(3)}, ${r.length} cand)` : "(none)"}` +
			`   [expect ${c.expect}]`
	)
}
backend.close?.()
process.exit(0)
