// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `@mailwoman/osm` — OpenStreetMap rooftop address-point ingestion. Permissive code; the ODbL
 *   obligation rides on the BUILT per-country shards, never on this package. See `./sdk` for the
 *   ingestion surface and `./scripts/build-rooftop-shard` for the build CLI.
 */

export * from "./sdk/index.ts"
