// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Northern Ireland `BT` postcode acquisition from OpenStreetMap — fetch → parse, the `ban/sdk` shape. See
 *   `./fetch.ts` for the ODbL obligation, the build-local tier, and why the query is a bbox.
 */

export * from "#gazetteer-pipeline/postcode/ni/osm/fetch"
export * from "#gazetteer-pipeline/postcode/ni/osm/parse"
