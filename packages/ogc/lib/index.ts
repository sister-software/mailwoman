// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `@mailwoman/ogc` serves Mailwoman through the OGC API family of standards.
 *
 *   It serves the OGC API Common Part 1 resources an OGC client reads first
 *   (the landing page, the conformance declaration and the API definition), the OGC API
 *   Common Part 2 collections, and forward geocoding at `/search` in PDOK's form.
 *   The conformance declaration names only the classes these routes implement.
 */

export * from "#app"
export * from "#bbox"
export * from "#collections"
export * from "#engine"
export * from "#format"
export * from "#html"
export * from "#items"
export * from "#projection"
export * from "#provenance"
export * from "#refusal"
export * from "#routes"
export * from "#schema"
