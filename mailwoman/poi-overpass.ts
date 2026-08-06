// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Re-homed to `@mailwoman/poi-taxonomy/overpass` — poi-taxonomy needed the emitter to build
 *   its own docs tester without depending on `@mailwoman/core`. This module is now a thin re-export so
 *   the `mailwoman/poi-overpass` subpath (and its tests) keep working unchanged.
 */

export * from "@mailwoman/poi-taxonomy/overpass"
