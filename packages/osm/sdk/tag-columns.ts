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
