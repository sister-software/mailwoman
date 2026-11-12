// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `@mailwoman/api-kit` — plumbing for Mailwoman's http surfaces: the node serve wrapper,
 *   OpenAPI emit helpers, generic timing metrics and the native error envelope.
 *
 *   The package contains plumbing only.
 *   By rule, domain schemas live next to their routes in the package that owns the wire
 *   interface (see the 2026-07-12 design spec's anti-meta guardrails).
 */

export * from "#error"
export * from "#geo"
export * from "#metrics"
export * from "#openapi"
export * from "#request"
export * from "#serve"
export * from "#engine-stamp"
