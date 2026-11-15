// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The package entry.
 *
 *   Phase 1 ships the grammar AST and its intermediate representation as Rust crates
 *   under `crates/`, and the committed IR under `data/ir/`.
 *   The TypeScript recognition API arrives with the engine in a later phase.
 *
 *   Until then this module declares the IR identity the generator checks the Rust writer against.
 */

/**
 * The `format` field of every IR document, as `recognize-core` writes it.
 */
export const IR_FORMAT = "mailwoman.recognize.ir"

/**
 * The IR version, as `recognize-core` writes it.
 */
export const IR_VERSION = 1
