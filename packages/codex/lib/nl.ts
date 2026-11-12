// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Dutch postal reference.
 *
 *   The PC6 postcode is the complete key for this system.
 *   `candidateSystemsForPostcode` checks which address-system shapes fit a postcode.
 *
 *   NL has no entry in that table.
 *   An NL entry would change the systems that function reports.
 */

export * from "#nl/postcode"
