// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `@mailwoman/api` — the native Mailwoman http API: an engine-agnostic `/v1` surface (parse,
 *   geocode, batch, resolve, format) alongside health, metrics, and an emitted OpenAPI document.
 *   It mimics no third-party API, so schemas are strict and validator-enforced rather than tolerant
 *   of legacy quirks. Routes take a {@link MailwomanAPIEngine}, which the `mailwoman` CLI wires to
 *   the real parse/geocode/resolve stack.
 */

export * from "#app"
export * from "#engine"
export * from "#routes"
export * from "#schema"
