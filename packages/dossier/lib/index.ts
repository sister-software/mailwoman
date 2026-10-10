// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   An opportunity dossier holds sourced claims over parcels, buildings, entrances and units,
 *   projected for an explicit as-of date with every unresolved question and the record that would
 *   resolve it, and the competing explanations for each failed availability check. Sourced memberships
 *   decide which building a layer reading attaches to, and sourced positions locate each building.
 */

export * from "#identifiers"
export * from "#time"
export * from "#sources"
export * from "#entities"
export * from "#links"
export * from "#claims"
export * from "#counts"
export * from "#events"
export * from "#availability"
export * from "#coverage"
export * from "#placement"
export * from "#filings"
export * from "#explanations"
export * from "#operator-results"
export * from "#validate"
export * from "#dossier"
export * from "#report"
