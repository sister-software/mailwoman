// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `@mailwoman/api` — the native Mailwoman http API: an engine-agnostic `/v1` surface
 *   (parse, geocode, batch, resolve, format) alongside health and metrics.
 *
 *   It emits an OpenAPI document.
 *   It implements the native Mailwoman API.
 *
 *   Schemas are strict and validator-enforced.
 *   Routes take a {@link MailwomanAPIEngine}, which the `mailwoman` CLI wires
 *   to the real parse/geocode/resolve stack.
 */

export * from "#app"
export * from "#doc-info"
export * from "#engine"
export * from "#routes"
export * from "#input-limits"
