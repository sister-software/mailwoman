// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Acquires Northern Ireland `BT` postcodes from OpenStreetMap through fetch and parse stages.
 *   The structure follows `ban/sdk`. See `./fetch.ts` for the ODbL obligation and build-local tier.
 *   That file also explains the bounding-box query.
 */

export * from "#tools/pipeline/postcode/ni/osm/fetch"
export * from "#tools/pipeline/postcode/ni/osm/parse"
