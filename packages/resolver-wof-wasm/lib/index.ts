// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

export { loadSlimWOFDatabase, type LoadSlimOpts } from "#loader"
export { WOFWasmPlaceLookup, type WOFWasmPlaceLookupOpts } from "#lookup"

// Re-export the shared interface types so callers don't need both packages on the typed path.
