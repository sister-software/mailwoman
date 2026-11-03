/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds the frozen famous-places fixture from the Wikidata query service.
 *
 *   Usage:
 *   node packages/mailwoman/tools/eval-harness/famous-places/build.run.ts [--out <jsonl>]
 *
 *   The entities are the capital of every sovereign state (`P36`, the country taken from the state), a hand-picked
 *   list of landmark articles on the English Wikipedia, and the most written-about national parks, waterfalls,
 *   canyons and geysers by `wikibase:sitelinks`, the number of Wikipedia language editions with an article. Each
 *   entity is written bare in English, with its country, and in its country's language where that label differs.
 *   Coordinates come from `P625`. Wikidata data is CC0.
 *
 *   The output is a frozen fixture: it is rebuilt deliberately and committed, because Wikidata changes daily.
 */

import { countrySurfaceForms } from "@mailwoman/codex/country/country"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { FAMOUS_PLACES_FIXTURE, type FamousPlaceRow } from "#tools/eval-harness/famous-places/score"

const { values } = parseArguments({
	options: { out: { type: "string", description: "Where to write the fixture" } },
})

const ENDPOINT = "https://query.wikidata.org/sparql"
const USER_AGENT = "mailwoman-famous-places/0.1 (https://github.com/sister-software/mailwoman)"
const LANGUAGES = ["en", "fr", "es", "de", "it", "pt", "ru", "ja", "zh", "ar"]

/**
 * The language a country's own speakers write a place in, for the local-name row. A country absent here gets none.
 */
const LOCAL_LANGUAGE: Record<string, string> = {
	FR: "fr",
	BE: "fr",
	SN: "fr",
	CI: "fr",
	ML: "fr",
	CM: "fr",
	ES: "es",
	MX: "es",
	AR: "es",
	CO: "es",
	PE: "es",
	CL: "es",
	VE: "es",
	EC: "es",
	BO: "es",
	UY: "es",
	PY: "es",
	CU: "es",
	DE: "de",
	AT: "de",
	IT: "it",
	PT: "pt",
	BR: "pt",
	AO: "pt",
	MZ: "pt",
	RU: "ru",
	BY: "ru",
	KZ: "ru",
	JP: "ja",
	CN: "zh",
	TW: "zh",
	EG: "ar",
	SA: "ar",
	JO: "ar",
	AE: "ar",
	MA: "ar",
	IQ: "ar",
	SY: "ar",
	LB: "ar",
	DZ: "ar",
	TN: "ar",
	LY: "ar",
	OM: "ar",
	QA: "ar",
	KW: "ar",
	BH: "ar",
	YE: "ar",
}

/**
 * The distance within which a geocode counts as the place, per kind. A natural feature covers a wide area, so its
 * Wikidata point stands for the whole feature and the tolerance is wider.
 */
const TOLERANCE_M: Record<string, number> = { capital: 15_000, landmark: 5_000 }
const NATURAL_TOLERANCE_M = 50_000

/**
 * English Wikipedia article titles of landmarks. A title that resolves to no item is reported and skipped.
 */
const LANDMARK_TITLES = [
	"Statue of Liberty",
	"Eiffel Tower",
	"Christ the Redeemer (statue)",
	"Colosseum",
	"Taj Mahal",
	"Great Wall of China",
	"Machu Picchu",
	"Petra",
	"Chichen Itza",
	"Stonehenge",
	"Sydney Opera House",
	"Big Ben",
	"Tower of London",
	"Tower Bridge",
	"Buckingham Palace",
	"Brandenburg Gate",
	"Neuschwanstein Castle",
	"Cologne Cathedral",
	"Sagrada Família",
	"Alhambra",
	"Acropolis of Athens",
	"Parthenon",
	"Leaning Tower of Pisa",
	"St. Peter's Basilica",
	"Trevi Fountain",
	"Notre-Dame de Paris",
	"Arc de Triomphe",
	"Louvre",
	"Palace of Versailles",
	"Mont-Saint-Michel",
	"Kremlin",
	"Saint Basil's Cathedral",
	"Red Square",
	"Hagia Sophia",
	"Burj Khalifa",
	"Great Pyramid of Giza",
	"Great Sphinx of Giza",
	"Angkor Wat",
	"Forbidden City",
	"Tiananmen Square",
	"Potala Palace",
	"Mount Fuji",
	"Tokyo Tower",
	"Tokyo Skytree",
	"Fushimi Inari-taisha",
	"Golden Gate Bridge",
	"Empire State Building",
	"Times Square",
	"Central Park",
	"Mount Rushmore",
	"White House",
	"United States Capitol",
	"Lincoln Memorial",
	"Hollywood Sign",
	"Space Needle",
	"Old Faithful",
	"Grand Prismatic Spring",
	"Grand Canyon",
	"Niagara Falls",
	"Victoria Falls",
	"Iguazu Falls",
	"Angel Falls",
	"Mount Everest",
	"Mount Kilimanjaro",
	"Matterhorn",
	"Mont Blanc",
	"Uluru",
	"Great Barrier Reef",
	"Mariana Trench",
	"Dead Sea",
	"Lake Baikal",
	"Amazon River",
	"Sahara",
	"Table Mountain",
	"Hạ Long Bay",
	"Galápagos Islands",
	"Easter Island",
	"Moai",
	"CN Tower",
	"Burj Al Arab",
	"Petronas Towers",
	"Marina Bay Sands",
	"Gateway of India",
	"Golden Temple",
	"Borobudur",
	"Shwedagon Pagoda",
	"Wat Arun",
	"Atomium",
	"Manneken Pis",
	"The Little Mermaid (statue)",
	"Charles Bridge",
	"Prague Castle",
	"Schönbrunn Palace",
	"Hallgrímskirkja",
	"Edinburgh Castle",
	"Cliffs of Moher",
	"Giant's Causeway",
	"Western Wall",
	"Dome of the Rock",
	"Kaaba",
	"Sheikh Zayed Grand Mosque",
	"Teotihuacan",
	"Sugarloaf Mountain",
	"Copacabana, Rio de Janeiro",
	"Perito Moreno Glacier",
	"Salar de Uyuni",
	"Torres del Paine National Park",
	"Cristo Rei",
	"Belém Tower",
	"Plaza de España, Seville",
	"Park Güell",
	"Rialto Bridge",
	"Doge's Palace",
	"Milan Cathedral",
	"Florence Cathedral",
	"Pantheon, Rome",
	"Vatican Museums",
	"Sistine Chapel",
	"Cedar Point",
	"Mount Vesuvius",
	"Mount Etna",
	"Kīlauea",
	"Death Valley",
	"Monument Valley",
	"Lake Tahoe",
]

/**
 * The natural-feature groups ranked by language-edition count. A large class times out when walked by subclass, so
 * each names its classes directly.
 */
const NATURAL_GROUPS: Array<{ kind: string; selection: string; limit: number }> = [
	{ kind: "national-park", selection: "?item wdt:P31 wd:Q46169.", limit: 30 },
	{ kind: "waterfall", selection: "?item wdt:P31 wd:Q34038.", limit: 15 },
	{ kind: "canyon", selection: "?item wdt:P31 wd:Q150784.", limit: 10 },
	{ kind: "geyser", selection: "VALUES ?class { wd:Q83471 wd:Q190869 } ?item wdt:P31 ?class.", limit: 10 },
]

interface Entity {
	qid: string
	kind: string
	country: string | null
	/**
	 * The English name of the state a capital belongs to, from Wikidata, for a country the codex lists no name for.
	 */
	countryName?: string
	lat: number
	lon: number
	labels: Record<string, string>
}

type Binding = Record<string, { value: string } | undefined>

const labelColumns = LANGUAGES.map((language) => `?label_${language}`).join(" ")
const labelOptionals = LANGUAGES.map(
	(language) => `OPTIONAL { ?item rdfs:label ?label_${language} FILTER(LANG(?label_${language}) = "${language}") }`
).join("\n")

async function select(query: string): Promise<Binding[]> {
	const response = await fetch(`${ENDPOINT}?format=json&query=${encodeURIComponent(query)}`, {
		headers: { "User-Agent": USER_AGENT, Accept: "application/sparql-results+json" },
	})

	if (!response.ok) throw new Error(`Wikidata query service answered HTTP ${response.status}`)
	const body = (await response.json()) as { results: { bindings: Binding[] } }

	// The query service asks clients to space their requests.
	await new Promise((resolve) => setTimeout(resolve, 2000))

	return body.results.bindings
}

function entityOf(binding: Binding, kind: string): Entity | null {
	const point = /Point\(([-\d.eE]+) ([-\d.eE]+)\)/u.exec(binding.coord?.value ?? "")

	if (!point) return null

	return {
		qid: binding.item!.value.replace("http://www.wikidata.org/entity/", ""),
		kind,
		country: binding.countryCode?.value ?? null,
		lat: Number(point[2]),
		lon: Number(point[1]),
		labels: Object.fromEntries(
			LANGUAGES.map((language) => [language, binding[`label_${language}`]?.value]).filter(([, value]) => value)
		),
	}
}

const entities = new Map<string, Entity>()
const keep = (entity: Entity | null) => entity && !entities.has(entity.qid) && entities.set(entity.qid, entity)

for (const binding of await select(`SELECT ?item ?coord ?countryCode ?stateName ${labelColumns} WHERE {
	?state wdt:P31 wd:Q3624078; wdt:P36 ?item; wdt:P297 ?countryCode.
	?state rdfs:label ?stateName FILTER(LANG(?stateName) = "en")
	?item wdt:P625 ?coord.
	${labelOptionals}
}`)) {
	const entity = entityOf(binding, "capital")

	if (entity && binding.stateName) entity.countryName = binding.stateName.value
	keep(entity)
}

const titles = LANDMARK_TITLES.map((title) => `"${title.replaceAll('"', '\\"')}"@en`).join(" ")
const resolvedTitles = new Set<string>()

for (const binding of await select(`SELECT ?title ?item ?coord ?countryCode ${labelColumns} WHERE {
	VALUES ?title { ${titles} }
	?article schema:about ?item; schema:isPartOf <https://en.wikipedia.org/>; schema:name ?title.
	?item wdt:P625 ?coord.
	OPTIONAL { ?item wdt:P17 ?country. ?country wdt:P297 ?countryCode. }
	${labelOptionals}
}`)) {
	resolvedTitles.add(binding.title!.value)
	keep(entityOf(binding, "landmark"))
}

for (const group of NATURAL_GROUPS) {
	for (const binding of await select(`SELECT ?item ?sitelinks ?coord ?countryCode ${labelColumns} WHERE {
		${group.selection}
		?item wikibase:sitelinks ?sitelinks; wdt:P625 ?coord.
		OPTIONAL { ?item wdt:P17 ?country. ?country wdt:P297 ?countryCode. }
		${labelOptionals}
	} ORDER BY DESC(?sitelinks) LIMIT ${group.limit}`)) {
		keep(entityOf(binding, group.kind))
	}
}

const rows: FamousPlaceRow[] = []

for (const entity of entities.values()) {
	const english = entity.labels.en

	if (!english) continue
	const tag = entity.kind === "capital" ? "locality" : "venue"
	const base = {
		qid: entity.qid,
		kind: entity.kind,
		country: entity.country,
		lat: entity.lat,
		lon: entity.lon,
		tolerance_m: TOLERANCE_M[entity.kind] ?? NATURAL_TOLERANCE_M,
	}

	rows.push({ ...base, form: "en", input: english, components: { [tag]: english } })
	// The codex's first surface form is the country's common English name (`Germany`, `Japan`).
	const countryName = (entity.country ? countrySurfaceForms(entity.country)[0] : undefined) ?? entity.countryName

	if (countryName) {
		rows.push({
			...base,
			form: "en-country",
			input: `${english}, ${countryName}`,
			components: { [tag]: english, country: countryName },
		})
	}

	const local = entity.country ? entity.labels[LOCAL_LANGUAGE[entity.country] ?? ""] : undefined

	if (local && local !== english) rows.push({ ...base, form: "local", input: local, components: { [tag]: local } })
}

rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.qid.localeCompare(b.qid) || a.form.localeCompare(b.form))

const out = values.out ?? FAMOUS_PLACES_FIXTURE

await writeLocalTextFile(rows.map((row) => JSON.stringify(row)).join("\n") + "\n", out)

console.log(`entities ${entities.size}, rows ${rows.length}, written to ${out}`)
console.log(
	`landmark titles unresolved: ${LANDMARK_TITLES.filter((title) => !resolvedTitles.has(title)).join(" | ") || "none"}`
)
