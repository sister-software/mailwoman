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
} from "./address-system-conventions.ts"
export * as au from "./au/index.ts"
export * as ca from "./ca/index.ts"
export * as de from "./de/index.ts"
export * as fr from "./fr/index.ts"
export * as gb from "./gb/index.ts"
export * as jp from "./jp/index.ts"
export * as nz from "./nz/index.ts"
export { candidateSystemsForPostcode, type SystemCode } from "./postcode-systems.ts"
export * as us from "./us/index.ts"
