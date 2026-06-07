/**
 * Validates the #386 hierarchy-aware regional-qualifier credit in oa-resolver-eval's
 * localityMatches, standalone against the real admin gazetteer. Replicates normName + the
 * ancestor-token matcher and asserts: (1) the four Saxony artifacts credit (gold `X <Kreis>` →
 * resolved `X`), and (2) negative controls do NOT credit (a wrong qualifier, or a qualifier matched
 * against an unrelated place's id).
 *
 * Node --experimental-strip-types scripts/diag-saxony-namematch.ts
 */
import { DatabaseSync } from "node:sqlite"

const DB = process.argv[2] ?? "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db"
const db = new DatabaseSync(DB, { readOnly: true })

const normName = (s: string | undefined): string => {
	if (!s) return ""
	const x = s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
	return x.replace(/\s+/g, " ").trim()
}

const ancStmt = db.prepare(
	"SELECT nm.name FROM ancestors a JOIN names nm ON nm.id = a.ancestor_id " +
		"WHERE a.id = ? AND a.ancestor_placetype IN ('county', 'region', 'macrocounty', 'macroregion')"
)
const ancestorTokensFor = (id: number): Set<string> => {
	const set = new Set<string>()
	for (const r of ancStmt.all(id) as { name: string }[])
		for (const t of normName(r.name).split(" ")) if (t.length >= 4) set.add(t)
	return set
}

// gold `<base> <qual…>` credits resolved place `id` (whose canonical name is `resolvedName`)
const credits = (gold: string, resolvedName: string, id: number): boolean => {
	const e = normName(gold)
	const base = normName(resolvedName)
	if (!base || !e.startsWith(base + " ")) return false
	const quals = e
		.slice(base.length + 1)
		.split(" ")
		.filter(Boolean)
	const anc = ancestorTokensFor(id)
	return quals.length > 0 && quals.every((q) => q.length >= 3 && [...anc].some((a) => a.startsWith(q)))
}

const idOf = (name: string): number =>
	(
		db.prepare("SELECT id FROM names WHERE name = ? AND placetype = 'locality' LIMIT 1").get(name) as
			| { id: number }
			| undefined
	)?.id ?? -1

const plauen = idOf("Plauen")
const chemnitz = idOf("Chemnitz")
// Pin the SAXON Marienberg (Erzgebirgskreis); idOf-by-name would grab the Rhineland-Palatinate one
// (county Westerwald), which the matcher correctly rejects for "Erzgeb" — the resolver, by contrast,
// picks the right Marienberg by coordinate, so in the real eval this is the place under test.
const marienberg = 101820701
const treuen = idOf("Treuen")
const munich = idOf("München") >= 0 ? idOf("München") : idOf("Munich")

type Case = { gold: string; resolved: string; id: number; want: boolean }
const cases: Case[] = [
	// Positives — the four artifacts from #386
	{ gold: "Plauen Vogtl", resolved: "Plauen", id: plauen, want: true },
	{ gold: "Chemnitz Sachs", resolved: "Chemnitz", id: chemnitz, want: true },
	{ gold: "Marienberg Erzgeb", resolved: "Marienberg", id: marienberg, want: true },
	{ gold: "Treuen Vogtl", resolved: "Treuen", id: treuen, want: true },
	// Negatives — must NOT over-credit
	{ gold: "Plauen Bayern", resolved: "Plauen", id: plauen, want: false }, // wrong region (Plauen is in Saxony, not Bavaria)
	{ gold: "Plauen Vogtl", resolved: "Munich", id: munich, want: false }, // right qualifier, wrong place's ancestry
	{ gold: "Plauen xy", resolved: "Plauen", id: plauen, want: false }, // too-short / nonsense qualifier
]

let pass = 0
for (const c of cases) {
	const got = c.id >= 0 ? credits(c.gold, c.resolved, c.id) : false
	const ok = got === c.want
	pass += ok ? 1 : 0
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${c.want ? "credit  " : "reject  "} gold="${c.gold}" → "${c.resolved}" (id=${c.id})  got=${got}`
	)
}
console.log(`\n${pass}/${cases.length} cases passed`)
db.close()
process.exit(pass === cases.length ? 0 : 1)
