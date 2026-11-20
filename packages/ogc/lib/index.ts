// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `@mailwoman/ogc` serves Mailwoman through the OGC API family of standards.
 *
 *   This stage serves the three OGC API Common Part 1 resources an OGC client reads first:
 *   the landing page, the conformance declaration and the API definition.
 *   The conformance declaration names only the classes these routes implement.
 */

export * from "#app"
export * from "#format"
export * from "#html"
export * from "#routes"
export * from "#schema"
