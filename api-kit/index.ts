// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `@mailwoman/api-kit` — plumbing for Mailwoman's HTTP surfaces: the node serve wrapper, OpenAPI
 *   emit helpers, generic timing metrics, and the native error envelope. Plumbing only, by rule:
 *   domain schemas live next to their routes in the package that owns the wire contract (see the
 *   2026-07-12 design spec's anti-meta guardrails).
 */

export * from "./error.ts"
export * from "./geo.ts"
export * from "./metrics.ts"
export * from "./openapi.ts"
export * from "./request.ts"
export * from "./serve.ts"
