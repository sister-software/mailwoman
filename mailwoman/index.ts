/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

// organize-imports-ignore
// Order matters: load @mailwoman/core first so every base class (WordClassifier, SectionClassifier,
// PhraseClassifier, CompositeClassifier) is fully defined before @mailwoman/classifiers evaluates
// any `extends` clause. Without this, source-mode test resolution surfaces the cycle as
// "Class extends value undefined".
export * from "@mailwoman/core"
export * from "@mailwoman/classifiers"
export * from "./runtime-pipeline.ts"
export * from "./default-placer.ts"
export * from "./utils/index.ts"
