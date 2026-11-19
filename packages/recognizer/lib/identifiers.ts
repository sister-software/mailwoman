// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `identifiers` family: its compiled artifact, its kinds and its payload types.
 *
 *   The family reads the names that stand in for a place: an H3 cell index, a geohash behind its prefix,
 *   a Who's On First reference, a Census GEOID and a GNIS feature identifier behind its prefix.
 *   A recognition of a GEOID or of a bare H3 cell is a candidate, because a bare run
 *   of digits is also a house number, a postcode or a count.
 *
 *   Whether the code points at a place that exists is a membership check for the data that owns it.
 *
 *   Import `identifiers` and pass it to `createRecognizer`.
 *   A bundle that imports this module holds this family's artifact and no other,
 *   and no engine until a recognizer is created.
 *
 *   `@mailwoman/recognizer/deterministic/identifiers` exports the predicate
 *   that decides when to trust a recognition.
 *
 *   The declarations are generated, and this module is their public path.
 */

export * from "#identifiers.generated"
