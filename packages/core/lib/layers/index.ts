// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The spatial-layer contract: manifest/coverage schema + IO. Every layer database — shipped,
 *   build-local, or private — embeds these tables. Spec:
 *   docs/superpowers/specs/2026-07-18-spatial-layers-and-poi-design.md §2.1.
 */

export * from "#layers/coverage"
export * from "#layers/feature-count"
export * from "#layers/manifest"
export * from "#layers/schema"
