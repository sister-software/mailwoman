/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Acquires Northern Ireland `BT` postcodes from OpenStreetMap through fetch and parse stages.
 *   The structure follows `ban/sdk`. See `./fetch.ts` for the ODbL obligation and build-local tier.
 *   That file also explains the bounding-box query.
 */

export * from "#gazetteer/postcode/ni/osm/fetch"
export * from "#gazetteer/postcode/ni/osm/parse"
