import { stringifyJSON } from "@mailwoman/core/json"

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file How an OSM tag is read out of a gdal OSM-driver layer in ogrsql, shared by the POI and sub-venue extractors.
 */

/**
 * Tag keys gdal's `osmconf.ini` promotes to real OGR fields, per layer: a promoted key is a bare column
 * and is removed from that layer's `other_tags` hstore, so an hstore lookup answers NULL for it.
 */
export type PromotedKeysByLayer = Readonly<Record<string, ReadonlySet<string>>>

/**
 * Ogrsql column aliases can't contain `:` — launder it the same way gdal's own
 * `attribute_name_laundering` would (`tower:type` -> `tower_type`).
 */
export function tagAlias(key: string): string {
	return key.replaceAll(":", "_")
}

/**
 * The SQL expression reading a tag's value on `layer`: a bare column when that layer promotes the key,
 * an `other_tags` hstore lookup otherwise.
 *
 * @throws on a layer with no promoted-key list, where an hstore fallback would run and match no row.
 */
export function tagSelectExpr(promotedKeysByLayer: PromotedKeysByLayer, layer: string, key: string): string {
	const promoted = promotedKeysByLayer[layer]

	if (!promoted) {
		throw new Error(
			`tagSelectExpr: no promoted-key list for OSM layer ${stringifyJSON(layer)} — known layers are ` +
				`${Object.keys(promotedKeysByLayer).join(", ")}`
		)
	}

	return promoted.has(key) ? key : `hstore_get_value(other_tags,'${key}')`
}

/**
 * OSM tag key/value shape — letters, digits, underscore, colon, dot, hyphen — which every token is checked
 * against before it reaches an ogrsql template, since a value such as `a' or 1=1 --` would otherwise inject
 * SQL.
 */
const SAFE_TAG_TOKEN = /^[A-Za-z0-9_:.-]+$/

/**
 * A tag-rule table entry as this module reads it: a conjunction (`and`) of `[key, value]` pairs, with `or`
 * across tags expressed as multiple rules in the table.
 */
export interface TagRuleLike {
	all: ReadonlyArray<[key: string, value: string]>
}

/**
 * Throws if any rule in `rules` carries a key or value outside {@link SAFE_TAG_TOKEN}, called at the top of
 * each SQL builder so a hostile rule table is refused before any string concatenation.
 *
 * `label` names the refusing builder in the error.
 */
export function assertSafeTagRules(rules: readonly TagRuleLike[], label: string): void {
	for (const rule of rules) {
		for (const [key, value] of rule.all) {
			for (const [kind, token] of [
				["key", key],
				["value", value],
			] as const) {
				if (!SAFE_TAG_TOKEN.test(token)) {
					throw new Error(
						`${label}: rule ${kind} ${stringifyJSON(token)} contains characters outside the OSM tag-token ` +
							`allowlist ${SAFE_TAG_TOKEN} — refusing to interpolate it into OGRSQL`
					)
				}
			}
		}
	}
}

/**
 * Distinct tag keys referenced across a rule table's `all` conjunctions, in first-seen order.
 */
export function distinctTagKeys(rules: readonly TagRuleLike[]): string[] {
	const seen = new Set<string>()

	for (const rule of rules) {
		for (const [key] of rule.all) {
			seen.add(key)
		}
	}

	return [...seen]
}
