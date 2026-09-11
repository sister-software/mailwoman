/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Sub-venue structure extractor (#35 wave 1) — stream the venue-INTERIOR features (airport
 *   terminals, boarding gates, station platforms) and their containing venues (aerodromes, stations,
 *   campuses) out of a Geofabrik `.osm.pbf` extract via GDAL/ogr2ogr, matched against an AND/OR
 *   tag-rule table and yielded as {@link SubVenueSourceRow}s. Mirrors `extract-poi.ts`'s
 *   process-spawn + GeoJSONSeq-over-stdout idiom; the two differences are the predicate (transport
 *   structure, not telecom infrastructure) and the LOCALIZED-NAME harvest described below.
 *
 *   WHY THIS EXISTS. `docs/engineering/sub-venue-corpus-task.mdx` establishes that `North Terminal` /
 *   `Upper Concourse` fail to parse because the `unit` tag was never TAUGHT the modifier+designator
 *   shape, not because a decode weight is too low — closing it by weight would need a bias scale near
 *   11 nats against the 6.0 the stronger designator+identifier evidence needed. The fix is corpus, and
 *   the densest real source of sub-venue naming in existence is airport and rail terminal data. OSM's
 *   `aeroway` key is already the provenance for `terminal` and `gate` in
 *   `neural/venue-structure.ts`'s designator vocabulary, so this extends a source we already reach
 *   rather than adding a dependency.
 *
 *   ── THE LOCALIZED-NAME HARVEST, and why `other_tags` is selected wholesale ─────────────────────────
 *   `extract-poi.ts` enumerates the tag keys it needs and reads each through `hstore_get_value`. That
 *   cannot work here: the payload this extractor exists for is the `name:<lang>` FAMILY, whose key set
 *   is unbounded (OSM carries `name:ja`, `name:es`, `name:zh-Hant`, …). So the whole `other_tags`
 *   hstore is selected as one column and parsed in JS ({@link parseOSMHstore}), which yields every
 *   localized name a feature carries at no extra query cost. `Terminal Sur`, `ターミナル5`,
 *   `Nordterminal` all arrive this way — the non-English designator surfaces the corpus task calls the
 *   cheapest route to.
 *
 *   ── Promoted vs. hstore tag columns, and why the split is PER-LAYER here ──────────────────────────
 *   GDAL's default `osmconf.ini` (`/usr/share/gdal/osmconf.ini`, GDAL 3.8.4 on this box) promotes a
 *   DIFFERENT attribute list per layer, and the two keys this extractor leans on fall on opposite sides
 *   of that split:
 *
 *   - `aeroway` is promoted on `multipolygons` but NOT on `points`.
 *   - `ref` is promoted on `points` but NOT on `multipolygons`.
 *
 *   So {@link PROMOTED_KEYS_BY_LAYER} is keyed by layer, and `tagSelectExpr` refuses a layer it has no list
 *   for rather than emitting hstore SQL that runs and matches nothing. Verified against the installed `osmconf.ini` and against a hand-authored `.osm`
 *   XML fixture read with the system `ogr2ogr` (GDAL's OSM driver reads plain OSM XML the same way it
 *   reads `.pbf`), which is also what `extract-subvenue.test.ts` pins. A custom `OSM_CONFIG_FILE` that
 *   changes either `attributes=` line breaks the bare-column assumption; not a concern for the shipped
 *   default.
 *
 *   A promoted key is NOT repeated inside `other_tags` — that is the whole point of promotion — so the
 *   JS-side re-check reads promoted keys off the feature's own properties and everything else out of
 *   the parsed hstore. {@link toSubVenueSourceRow} merges the two before matching.
 *
 *   ── What this does NOT do ────────────────────────────────────────────────────────────────────────
 *   No parent linkage. A terminal's containing aerodrome is expressed in OSM by geometry (or an
 *   occasional site relation), not by a parent id, so pairing `Terminal 5` with `Heathrow Airport`
 *   needs a spatial join this module deliberately does not attempt. Both tiers are yielded with their
 *   coordinates and a {@link SubVenueTier} discriminator; pairing is the consumer's job.
 *
 *   No `country` either, for the same reason `extract-poi.ts` has none: a Geofabrik extract's country
 *   is a property of the invocation, not of a feature. Rows carry `country: ""` and the caller stamps it.
 */

import { openWriteStream } from "@mailwoman/core/fs/streams"
import { once } from "@mailwoman/core/utils/events"
import { ogr2ogrGeoJSONSeq } from "@mailwoman/spatial/tools/ogr-stream"

import {
	buildSubVenueSQL,
	distinctSubVenueTagKeys,
	matchSubVenueTagRule,
	type SubVenueTagRule,
	type SubVenueTier,
	SUBVENUE_LAYERS,
	SUBVENUE_TAG_RULES,
} from "#sdk/extract/subvenue/rules"
import { representativePoint } from "#sdk/representative-point"
import { tagAlias } from "#sdk/tag-columns"

export {
	buildSubVenueSQL,
	distinctSubVenueTagKeys,
	matchSubVenueTagRule,
	type SubVenueTagRule,
	SubVenueTier,
	SUBVENUE_TAG_RULES,
} from "#sdk/extract/subvenue/rules"

/**
 * Parse GDAL's `other_tags` hstore rendering into a plain dict.
 *
 * The format is `"key"=>"value","key2"=>"value2"`, with `\"` and `\\` escaped inside either half. A regex split on `,`
 * is WRONG — comma is ordinary text inside a value, and OSM names contain them (`"name"=>"Terminal 1, Departures"`) —
 * so this is a character scanner that only leaves a quoted string on an unescaped quote.
 *
 * Returns an empty dict for `null`/empty input rather than throwing: `other_tags` is absent whenever every tag on a
 * feature was promoted, which is an ordinary outcome, not a fault.
 */
export function parseOSMHstore(text: string | null | undefined): Record<string, string> {
	const out: Record<string, string> = {}

	if (!text) return out

	let i = 0

	/**
	 * Read one `"…"` literal starting at the next quote, honoring backslash escapes. Returns `null` at end of input.
	 */
	const readQuoted = (): string | null => {
		while (i < text.length && text[i] !== '"') {
			i++
		}

		if (i >= text.length) return null

		i++

		let value = ""

		while (i < text.length) {
			const ch = text[i]!

			if (ch === "\\") {
				// A backslash escapes the next character verbatim — the only two GDAL emits are `\"` and `\\`,
				// but passing anything else through unchanged is the lossless choice.
				if (i + 1 < text.length) {
					value += text[i + 1]
				}

				i += 2

				continue
			}

			if (ch === '"') {
				i++

				return value
			}

			value += ch

			i++
		}

		// Unterminated literal — treat what we read as the value rather than dropping the whole feature.
		return value
	}

	while (i < text.length) {
		const key = readQuoted()

		if (key === null) break

		// Step over the `=>` separator; a malformed pair just resolves to the next quoted run.
		const value = readQuoted()

		if (value === null) break
		out[key] = value
	}

	return out
}

/**
 * Language codes harvested off `name:<lang>` keys. Deliberately permissive — OSM carries BCP-47-ish subtags (`zh-Hant`,
 * `pt-BR`) alongside bare ISO 639 codes, and the lexicon build downstream is the right place to decide which it trusts.
 * What this rejects is the `name:*` keys that are NOT languages: `name:left`, `name:right`, `name:prefix`,
 * `name:signed`, `name:etymology` and friends, which are documented OSM semantics with nothing linguistic about them.
 */
const NON_LANGUAGE_NAME_SUFFIXES = new Set([
	"left",
	"right",
	"prefix",
	"suffix",
	"signed",
	"source",
	"etymology",
	"pronunciation",
	"abbreviation",
	"botanical",
	"carto",
])

const LANGUAGE_SUBTAG = /^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/

/**
 * Pull the `name:<lang>` family out of a tag dict, keyed by the raw subtag as OSM wrote it.
 */
export function harvestLocalizedNames(tags: Readonly<Record<string, string | undefined>>): Record<string, string> {
	const out: Record<string, string> = {}

	for (const [key, value] of Object.entries(tags)) {
		if (!value || !key.startsWith("name:")) continue

		const subtag = key.slice("name:".length)

		if (NON_LANGUAGE_NAME_SUFFIXES.has(subtag) || !LANGUAGE_SUBTAG.test(subtag)) continue
		out[subtag] = value
	}

	return out
}

/**
 * One extracted transport structure. The shape a sub-venue lexicon build and a corpus extract both read.
 */
export interface SubVenueSourceRow {
	/**
	 * The designator the matched rule attests — `terminal`, `gate`, `platform`, `station`, `airport`, `campus`.
	 */
	designatorID: string
	tier: SubVenueTier
	/**
	 * The feature's default `name` tag, `null` when unnamed. A gate is very often unnamed and carries only `ref`.
	 */
	name: string | null
	/**
	 * The feature's `ref` tag — the identifier half of `Gate A12` / `Terminal 2F`, which OSM keeps out of `name` far more
	 * consistently than it keeps it in.
	 */
	ref: string | null
	/**
	 * `name:<lang>` → value, the localized surfaces. Empty when the feature carries none.
	 */
	localizedNames: Record<string, string>
	latitude: number
	longitude: number
	/**
	 * `key=value` of the rule branch that matched, so a row's provenance survives into the lexicon.
	 */
	matchedTag: string
	/**
	 * Always `""` — see the module docstring. The caller stamps the invocation's country.
	 */
	country: string
}

/**
 * Decode one ogr2ogr GeoJSONSeq feature into a {@link SubVenueSourceRow}, or `null` when it satisfies no rule, carries
 * no usable geometry, or has no name of ANY kind (no `name`, no `ref`, no `name:<lang>`).
 *
 * The last condition is the yield filter that matters: unnamed geometry is the majority of `railway=platform` and
 * `aeroway=gate` in OSM, and a lexicon built from names has nothing to learn from a row that has none.
 *
 * `promotedProps` are the feature's own GeoJSON properties (aliased tag columns plus `name`/`ref`); everything else
 * comes out of the parsed `other_tags` hstore. The two are merged before matching because a key's side of that split is
 * a property of the LAYER, not of the rule.
 */
export function toSubVenueSourceRow(
	feature: { properties?: Record<string, unknown>; geometry?: { type?: string; coordinates?: unknown } },
	rules: readonly SubVenueTagRule[],
	tagKeys: readonly string[]
): SubVenueSourceRow | null {
	const p = feature.properties ?? {}
	const hstore = parseOSMHstore(typeof p["other_tags"] === "string" ? p["other_tags"] : null)
	const tags: Record<string, string | undefined> = { ...hstore }

	// Aliased rule columns win over the hstore: on a layer that promotes the key, the hstore has no
	// entry for it at all, and on a layer that does not, the alias was READ from the hstore anyway.
	for (const key of tagKeys) {
		const raw = p[tagAlias(key)]

		if (raw != null && raw !== "") {
			tags[key] = String(raw)
		}
	}

	const rule = matchSubVenueTagRule(tags, rules)

	if (!rule) return null

	const pt = representativePoint(feature.geometry)

	if (!pt) return null

	const rawName = p["name"] ?? tags["name"]
	const rawRef = p["ref"] ?? tags["ref"]
	const name = rawName != null && rawName !== "" ? String(rawName) : null
	const ref = rawRef != null && rawRef !== "" ? String(rawRef) : null
	const localizedNames = harvestLocalizedNames(tags)

	if (!name && !ref && !Object.keys(localizedNames).length) return null

	const matched = rule.all.find(([key]) => tags[key] !== undefined) ?? rule.all[0]!

	return {
		designatorID: rule.designatorID,
		tier: rule.tier,
		name,
		ref,
		localizedNames,
		longitude: pt[0],
		latitude: pt[1],
		matchedTag: `${matched[0]}=${matched[1]}`,
		country: "",
	}
}

/**
 * Run ogr2ogr against one layer, yielding matched {@link SubVenueSourceRow}s from its GeoJSONSeq stdout. Mirrors
 * `extract-poi.ts`'s `runPOILayer` process-spawn / stderr-capture / exit-code idiom exactly.
 */
async function* runSubVenueLayer(
	pbfPath: string,
	layer: string,
	rules: readonly SubVenueTagRule[]
): AsyncGenerator<SubVenueSourceRow> {
	const tagKeys = distinctSubVenueTagKeys(rules)
	const sql = buildSubVenueSQL(layer, rules)
	const args = ["-f", "GeoJSONSeq", "/vsistdout/", "-dialect", "OGRSQL", "-sql", sql, pbfPath]

	for await (const feature of ogr2ogrGeoJSONSeq<{
		properties?: Record<string, unknown>
		geometry?: { type?: string; coordinates?: unknown }
	}>(args, `osm sub-venue (${layer})`)) {
		const row = toSubVenueSourceRow(feature, rules, tagKeys)

		if (row) {
			yield row
		}
	}
}

/**
 * Stream every named transport structure matching `rules` (default {@link SUBVENUE_TAG_RULES}) out of a `.osm.pbf`
 * extract's `points` + `multipolygons` layers.
 *
 * A feature mapped as both a node and an area (common for large terminals) yields TWICE, once per layer, with different
 * coordinates. De-duplication is the consumer's call — the lexicon build counts distinct surfaces and does not care,
 * while a corpus extract would.
 */
export async function* extractOSMSubVenues(
	pbfPath: string,
	rules: SubVenueTagRule[] = SUBVENUE_TAG_RULES
): AsyncIterable<SubVenueSourceRow> {
	for (const layer of SUBVENUE_LAYERS) {
		yield* runSubVenueLayer(pbfPath, layer, rules)
	}
}

export interface WriteSubVenueJSONLOptions {
	pbfPath: string
	outPath: string
	/**
	 * ISO 3166-1 alpha-2 stamped onto every row. A Geofabrik extract's country is a property of the INVOCATION — see the
	 * module docstring — so it arrives here rather than out of a feature.
	 */
	country?: string
	rules?: SubVenueTagRule[]
}

/**
 * Run the extractor over one `.osm.pbf` and write the rows as JSONL, one object per line.
 *
 * The step between a Geofabrik download and `mailwoman corpus sub-venue-lexicon`, factored out of the ad-hoc script
 * wave 1 used because wave 2 runs it five times. Backpressure is honoured (`drain`) — the Japan extract is 184,000 rows
 * and 40 MB, and an unawaited `write` loop buffers all of it. Measured on this box: 340 MB of Hessen produced 27,234
 * rows in 44 s, 2.5 GB of Japan produced 183,999 in 371 s, both dominated by ogr2ogr rather than by this loop.
 *
 * Returns the row count.
 */
export async function writeSubVenueJSONL(options: WriteSubVenueJSONLOptions): Promise<number> {
	const stream = openWriteStream(options.outPath)
	let rows = 0

	for await (const row of extractOSMSubVenues(options.pbfPath, options.rules)) {
		if (options.country) {
			row.country = options.country
		}

		if (!stream.write(JSON.stringify(row) + "\n")) {
			await once(stream, "drain")
		}

		rows++
	}

	await new Promise<void>((resolve, reject) => {
		stream.end((error?: Error | null) => (error ? reject(error) : resolve()))
	})

	return rows
}
