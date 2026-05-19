// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

// organize-imports-ignore
// Order matters: load @mailwoman/core first so every base class (WordClassifier, SectionClassifier,
// PhraseClassifier, CompositeClassifier) is fully defined before @mailwoman/classifiers evaluates
// any `extends` clause. Without this, source-mode test resolution surfaces the cycle as
// "Class extends value undefined".
export * from "@mailwoman/core"
export * from "@mailwoman/classifiers"
export * from "./utils/index.js"
