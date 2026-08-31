/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file How an OSM tag is read out of a GDAL OSM-driver layer in OGRSQL, shared by the POI and sub-venue extractors.
 */

/**
 * Tag keys GDAL's `osmconf.ini` promotes to real OGR fields, per layer. A promoted key is selected as a bare column and
 * is REMOVED from that layer's `other_tags` hstore, so reading it through `hstore_get_value` answers NULL for every
 * feature of the layer.
 */
export type PromotedKeysByLayer = Readonly<Record<string, ReadonlySet<string>>>

/**
 * OGRSQL column aliases can't contain `:` — launder it the same way GDAL's own `attribute_name_laundering` would
 * (`tower:type` -> `tower_type`).
 */
export function tagAlias(key: string): string {
	return key.replaceAll(":", "_")
}

/**
 * The SQL expression reading a tag's value on `layer`: a bare column when that layer promotes the key, an `other_tags`
 * hstore lookup otherwise.
 *
 * Throws on a layer with no promoted-key list. Falling back to the hstore expression for an unknown layer would produce
 * SQL that runs and matches nothing, which is the failure the table exists to prevent.
 */
export function tagSelectExpr(promotedKeysByLayer: PromotedKeysByLayer, layer: string, key: string): string {
	const promoted = promotedKeysByLayer[layer]

	if (!promoted) {
		throw new Error(
			`tagSelectExpr: no promoted-key list for OSM layer ${JSON.stringify(layer)} — known layers are ` +
				`${Object.keys(promotedKeysByLayer).join(", ")}`
		)
	}

	return promoted.has(key) ? key : `hstore_get_value(other_tags,'${key}')`
}

/**
 * OSM tag key/value shape: letters, digits, underscore, colon, dot, hyphen. The SQL builders interpolate rule
 * keys/values directly into OGRSQL strings, and rule tables are public, caller-suppliable parameters — so every token
 * is checked against this allowlist before any of it reaches a template string. A hostile value such as `a' OR 1=1 --`
 * would otherwise close the `'...'` literal early and inject arbitrary OGRSQL. Rejecting outright is a stronger,
 * simpler guarantee than trying to enumerate escape rules for GDAL's OGRSQL dialect.
 */
export const SAFE_TAG_TOKEN = /^[A-Za-z0-9_:.-]+$/

/**
 * A tag-rule table entry as this module reads it: a conjunction (AND) of `[key, value]` pairs. OR across tags is
 * expressed as multiple rules in the table.
 */
export interface TagRuleLike {
	all: ReadonlyArray<[key: string, value: string]>
}

/**
 * Throws if any rule in `rules` carries a key or value outside {@link SAFE_TAG_TOKEN} — called at the top of each SQL
 * builder, so it and the extractors built over it refuse a hostile rule table before any string concatenation happens.
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
						`${label}: rule ${kind} ${JSON.stringify(token)} contains characters outside the OSM tag-token ` +
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
