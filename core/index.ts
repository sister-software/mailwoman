/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

// `resources` triggers top-level await (libpostal data scan). Keep it LAST so consumers using
// bare `@mailwoman/core` for non-resource exports (classifiers, tokenization, decoder, …) can
// resolve those exports before TLA pauses the module. Re-ordering broke
// `class extends WordClassifier` evaluation under Vite's TLA-aware loader.
export * from "./classification/index.js"
export * from "./decoder/index.js"
export * from "./formatter/index.js"
export * from "./parser/index.js"
export * from "./solver/index.js"
export * from "./tokenization/index.js"
export * from "./types/index.js"
export * from "./resources/index.js"
