// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `spatial` family: its compiled artifact, its kinds and its payload types.
 *
 *   The family reads the grid codes and documents that stand for a place: the Open
 *   Location Code (`plus_code.token`), DIGIPIN (`digipin.compact` and `digipin.display`)
 *   and a GeoJSON text (`geojson.object`).
 *   It decodes none of them: decoding a code to its cell is arithmetic that stays in `@mailwoman/spatial`.
 *
 *   Import `spatial` and pass it to `createRecognizer`.
 *   A bundle that imports this module holds this family's artifact and no other,
 *   and no engine until a recognizer is created.
 *
 *   `@mailwoman/recognize/deterministic/spatial` exports the predicate that decides
 *   when to trust a recognition.
 *
 *   A GeoJSON text is at most 65,536 bytes, the family's input limit.
 *   The engine refuses a longer text before it searches, whatever the text holds.
 *
 *   The declarations are generated, and this module is their public path.
 */

export * from "#spatial.generated"
