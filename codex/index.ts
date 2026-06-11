/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/codex` — per-address-system postal reference data and branded types.
 *
 *   Each address system (the USPS for the United States, La Poste for France, Deutsche Post for
 *   Germany, …) has its own conventions for what a postcode, a street suffix, or a unit designator
 *   looks like. This package is the shared, dependency-free home for that reference knowledge, kept
 *   apart from the locale-agnostic tokenizer/solver in `@mailwoman/core` and from the training
 *   pipeline in `@mailwoman/corpus`. The parser, the resolver, and the synthesis layer all reach
 *   for the same tables instead of each carrying their own copy.
 *
 *   Systems are exposed as namespaces (`import { us } from "@mailwoman/codex"`) and as subpaths
 *   (`import { lookupStreetSuffix } from "@mailwoman/codex/us"`). The cross-system
 *   `candidateSystemsForPostcode` (the inverse of the per-slice postcode patterns) is a top-level
 *   export.
 */

export {
	ADDRESS_SYSTEM_CONVENTIONS,
	conventionsForSystem,
	type AddressSystemConventions,
} from "./address-system-conventions.js"
export * as au from "./au/index.js"
export * as ca from "./ca/index.js"
export * as de from "./de/index.js"
export * as fr from "./fr/index.js"
export * as gb from "./gb/index.js"
export * as jp from "./jp/index.js"
export * as nz from "./nz/index.js"
export { candidateSystemsForPostcode, type SystemCode } from "./postcode-systems.js"
export * as us from "./us/index.js"
