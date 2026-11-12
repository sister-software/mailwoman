// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Serves a libpostal-compatible parse and expand HTTP API over Mailwoman's parser.
 *
 *   The `/parse` endpoint returns labeled spans without gazetteer or resolver lookups.
 *   The mapping to libpostal labels lives in `engine.ts`.
 */

export * from "#app"
export * from "#engine"
export * from "#schema"
