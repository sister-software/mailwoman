// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Reads BAN département CSVs and builds French rooftop address-point extracts in the shared situs schema.
 * BAN data is under Licence Ouverte / Etalab, so published results must keep the row attribution.
 */

export * from "#sdk/fetch"
export * from "#sdk/extract"
export * from "#sdk/street-locale"
export * from "#sdk/region-database-provider"
