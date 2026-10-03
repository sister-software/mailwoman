// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The typed-evidence interface. Zero runtime dependencies BY design: `@mailwoman/bdc`, `@mailwoman/resolver`,
 *   `@mailwoman/filer` and `@mailwoman/match` all consume this. Two of them are leaves. A dependency on
 *   `@mailwoman/core` would add core's shipped data to every consumer. That data size also explains why
 *   `nuts-lookup` and `timezone-lookup` re-implement a ray cast rather than depend on `@mailwoman/spatial`. Do not add
 *   a dependency here.
 */

export * from "#coverage"
export * from "#derivation"
export * from "#evidence"
export * from "#status"
