/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `fr-fragment` shard recipe (#727 T2) — the HOUSE-NUMBER-LICENCE lever.
 *
 *   The measured problem (T1c, `2026-07-16-t1c-fragment-board-verdict.md`): the shipped model scores
 *   **0.925** on `<n> Rue X` and **0.215** on `Rue X`. Same streets, same model; the only difference
 *   is a leading number. It has learned that a house number LICENSES a street reading at all — strip
 *   it and a designator-led phrase parses as a locality, designator included:
 *
 *   ```
 *   "Rue Montmartre"        -> locality="Rue Montmartre"
 *   "Allee Poque"           -> locality="Allee Poque"
 *   ```
 *
 *   `Rue` can only mean street in French. The model is not mislabelling an ambiguous toponym; it is
 *   mislabelling `Rue`.
 *
 *   WHY THE EXISTING RECIPE DOESN'T COVER THIS. {@link frBareStreetRecipe} (#251) mints
 *   `<n> Rue <name>, <City>` — the bare COMMA form, no postcode. It targets postcode-anchoring
 *   imbalance, and every row it emits still carries a house number AND a locality. It cannot teach
 *   the class above, because it never shows the model a street standing alone.
 *
 *   WHAT THIS MINTS. Five street forms — the first three carry NO house number and NO locality, which
 *   is the whole point — plus the counter-distribution:
 *
 *   1. `bare-street`         "Rue Montmartre"
 *   2. `street-particle`     "Rue de la Paix"
 *   3. `date-name`           "Allee du 11 Novembre 1918"
 *   4. `street-housenumber`  "12 Rue Montmartre"     — the anchor, so the licence isn't UNLEARNED
 *   5. `alnum-housenumber`   "12 bis Rue Montmartre"
 *   6. `bare-locality`       "Mery-sur-Oise"         — NEGATIVE: a bare toponym that IS a locality
 *
 *   The **admin/street homonym** class (`Rue de Rome`) is deliberately NOT a separate form. Homonym
 *   streets are already in the register and fall into 1–3 naturally; there is nothing different to
 *   teach about them, because the lesson is identical — the designator makes it a street. The
 *   fragment board scores them separately (they need measuring, not minting), and the recipe would
 *   need a second pass over the commune set to label them, buying a `synth_method` string and no
 *   training signal.
 *
 *   FORM 7 IS NOT OPTIONAL. T1c's standing prediction: the board's `bare-locality` cell reads 0.980
 *   for the WRONG REASON — the model calls everything without a house number a locality, and on bare
 *   localities that is accidentally right. Teach bare streets alone and the model has every incentive
 *   to flip that default rather than learn the distinction, trading a 0.215 for a 0.980. The shard
 *   must show BOTH bare forms so the discriminating evidence is the designator, which is the only
 *   thing that actually distinguishes them. This is the same counter-distribution principle
 *   {@link noStreetRecipe} established after synth-street pushed the model into "decompose mode".
 *
 *   SPLIT. `--exclude-surfaces` takes the fragment board's reserved surface list
 *   (`mailwoman/eval-harness/fixtures/ban-fragments-fr.surfaces.txt`). Every listed surface is
 *   skipped — source-disjoint by normalized street SURFACE, never by record row. Row-disjoint leaks
 *   the surface across the boundary and measures memorization of `Rue de Rivoli` while claiming
 *   generalization to unseen streets. The recipe REFUSES to run without the list rather than
 *   silently minting a contaminated shard.
 *
 *   MIX. The shard is ~145K rows off a 120K-tuple draw; the intended corpus mix is **5–10%**, set at
 *   assembly time by shard weight rather than by row count. Keep the cap: a shard that fixes fragments
 *   by degrading full addresses has moved the failure, not fixed it — which is what
 *   `street-housenumber` / `alnum-housenumber` on the fragment board and the global parity floor are
 *   there to catch. `date-name` is ~0.5% of the shard because BAN only holds ~1,418 date-name streets
 *   after filtering and the tuple extractor already takes every one; if that class needs more, the
 *   lever is shard weight, not invented data.
 *
 *   ⚠ Convention loss-mask: like {@link frBareStreetRecipe}, this recipe TEACHES FR `street_prefix`.
 *   The conventions loss-mask forbids it for FR and will `-inf` these gold labels (the v1.6.0 ~7M-loss
 *   blow-up). Disable that mask for any run including this shard.
 */

import { readFileSync } from "node:fs"

import { decomposeFrStreet } from "../adapters/ban/street-decompose.ts"
import { alignAndWrite, makeMulberry32, readTuples, type ShardRecipe, shardSourceID } from "./scaffold.ts"

/** House numbers, weighted toward the small values that dominate real BAN rows. */
const HOUSE_NUMBERS = [
	1, 1, 2, 2, 3, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 18, 20, 21, 24, 27, 30, 33, 42, 57, 68, 84, 102, 115, 140,
]
/** FR alphanumeric house-number forms. `bis`/`ter` are separated; a bare letter is suffixed. */
const ALNUM_SUFFIXES = ["bis", "ter", "A", "B"]

const norm = (value: string): string =>
	value
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim()

/**
 * French commune convention: capitalize each element, leave the joining particles lowercase. `saint-jean-de-luz` →
 * `Saint-Jean-de-Luz`, not `Saint-Jean-De-Luz`.
 *
 * Needed because BAN's sharded DBs keep only `locality_base` — normalized, lowercase, accent-stripped. Emitting that
 * verbatim would teach the counter-distribution that a lowercase accent-stripped string is a locality, which is not a
 * fact about French and would not match the fragment board (which reconstructs the same casing). The accents are gone
 * from the source and cannot be recovered here; the casing can.
 */
const FR_LOWER = new Set([
	"le",
	"la",
	"les",
	"de",
	"du",
	"des",
	"d",
	"l",
	"sur",
	"sous",
	"en",
	"aux",
	"au",
	"et",
	"lez",
])

export function frTitleCase(value: string): string {
	const cap = (token: string, first: boolean): string =>
		!first && FR_LOWER.has(token) ? token : token.charAt(0).toUpperCase() + token.slice(1)

	return value
		.split(" ")
		.map((word, wordIndex) =>
			word
				.split("-")
				.map((bit, bitIndex) => cap(bit, wordIndex === 0 && bitIndex === 0))
				.join("-")
		)
		.join(" ")
}

/** Does the street name carry a particle? Decides the particle vs bare classification. */
const PARTICLE = /\b(de la|de l'|du|des|de|d'|le|la|les)\b/i
/** Does the street name carry date material (a year, or a day + French month)? */
const DATEISH =
	/\b(1[0-9]|20)\d{2}\b|\b\d{1,2}\s+(janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[ûu]t|septembre|octobre|novembre|d[ée]cembre)\b/i

export const frFragmentRecipe: ShardRecipe = {
	name: "fr-fragment",
	description:
		"FR street fragments with NO house number (#727 T2): the house-number-licence lever — bare/particle/date-name/homonym + the bare-locality counter",
	mode: "tuples",
	options: [
		{
			flag: "--exclude-surfaces <path>",
			description: "REQUIRED. The fragment board's reserved surface list; every listed street is skipped.",
		},
		{
			flag: "--hn-prob <n>",
			description: "Share of rows carrying a house number (default 0.35 — the anchor, not the point)",
		},
		{
			flag: "--bare-prob <n>",
			description: "Share of NO-house-number rows that are bare LOCALITIES (default 0.25 — the counter)",
		},
	],
	async run(opts, write) {
		const random = makeMulberry32(opts.seed)
		const excludePath = opts.excludeSurfaces

		if (!excludePath) {
			throw new Error(
				"fr-fragment: --exclude-surfaces is REQUIRED. Pass the fragment board's reserved list " +
					"(mailwoman/eval-harness/fixtures/ban-fragments-fr.surfaces.txt) or this shard trains on its own eval set. " +
					"Source-disjoint by street SURFACE is the split discipline; there is no safe default."
			)
		}

		const excluded = new Set(
			readFileSync(excludePath, "utf8")
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line && !line.startsWith("#"))
		)

		if (!excluded.size) throw new Error(`fr-fragment: --exclude-surfaces "${excludePath}" listed no surfaces`)

		const hnProb = opts.hnProb ?? 0.35
		const bareLocalityProb = opts.bareProb ?? 0.25

		// The locality pool is harvested from the tuples themselves — every BAN row carries its
		// commune, so the counter-distribution needs no second source.
		const localities = new Set<string>()

		let read = 0
		let emitted = 0
		let skipped = 0
		let contaminated = 0

		for await (const tuple of readTuples(opts.input!)) {
			read++
			const fullStreet = String(tuple.street ?? "").trim()
			const locality = String(tuple.locality ?? "").trim()

			if (locality) localities.add(locality)

			if (!fullStreet) {
				skipped++
				continue
			}

			// THE SPLIT. A surface on the fragment board never enters training.
			if (excluded.has(norm(fullStreet))) {
				contaminated++
				continue
			}

			const { prefix, street } = decomposeFrStreet(fullStreet)

			// The failing class is the designator-led street. A no-prefix nom_voie ("La Ville Mois")
			// is a different problem and would muddy the signal.
			if (!prefix || !street) {
				skipped++
				continue
			}

			const carriesNumber = random() < hnProb
			const components: Record<string, string> = { street_prefix: prefix, street }
			let raw = `${prefix} ${street}`
			let klass = DATEISH.test(street) ? "date-name" : PARTICLE.test(street) ? "street-particle" : "bare-street"

			if (carriesNumber) {
				const number = HOUSE_NUMBERS[Math.floor(random() * HOUSE_NUMBERS.length)]!
				const alnum = random() < 0.25
				const suffix = ALNUM_SUFFIXES[Math.floor(random() * ALNUM_SUFFIXES.length)]!
				const houseNumber = alnum
					? suffix === "bis" || suffix === "ter"
						? `${number} ${suffix}`
						: `${number}${suffix}`
					: String(number)
				components.house_number = houseNumber
				raw = `${houseNumber} ${prefix} ${street}`
				klass = alnum ? "alnum-housenumber" : "street-housenumber"
			}

			const sourceID = shardSourceID("synth-fr-fragment", { ...components, v: String(read) })

			if (
				alignAndWrite(
					write,
					{
						raw,
						components,
						country: "FR",
						locale: "fr-FR",
						source: "synth-fr-fragment",
						source_id: sourceID,
						corpus_version: "0.9.4",
						license: "Synthetic — fr-fragment; (street, commune) from BAN (Base Adresse Nationale, Licence Ouverte)",
					},
					`fr-fragment:${klass}`
				)
			) {
				emitted++
			} else {
				skipped++
			}
		}

		// ---- the counter-distribution: bare localities, NO street anywhere in the row -------------
		// Minted last so the locality pool is complete. Without these the model can satisfy every row
		// above by flipping its default from "bare => locality" to "bare => street", which trades one
		// broken prior for another and would show up as bare-locality collapsing on the board.
		const pool = [...localities].sort()
		const wanted = Math.round((emitted / Math.max(1, 1 - bareLocalityProb)) * bareLocalityProb)

		for (let i = 0; i < wanted && pool.length; i++) {
			// BAN gives `locality_base` normalized; restore the casing the fragment board also
			// reconstructs, so train and eval show the model the same shape of French.
			const name = frTitleCase(pool[Math.floor(random() * pool.length)]!)
			const sourceID = shardSourceID("synth-fr-fragment", { locality: name, v: `neg-${i}` })

			if (
				alignAndWrite(
					write,
					{
						raw: name,
						components: { locality: name },
						country: "FR",
						locale: "fr-FR",
						source: "synth-fr-fragment",
						source_id: sourceID,
						corpus_version: "0.9.4",
						license: "Synthetic — fr-fragment counter-distribution; commune from BAN (Licence Ouverte)",
					},
					"fr-fragment:bare-locality"
				)
			) {
				emitted++
			} else {
				skipped++
			}
		}

		if (contaminated) {
			console.error(`fr-fragment: skipped ${contaminated} rows whose street surface is reserved by the fragment board`)
		}

		return { read, emitted, skipped }
	},
}
