/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Re-export shim: the name-prone set moved to `@mailwoman/codex/us` (data in
 * `codex/us/street-suffix.json`, 2026-08-10) so the golden relabel flags, the #1569 slice
 * recipe, AND the Python relabel pass (via the `gazetteer affix-relabel` v2 lexicon) all read
 * one record. Import from `@mailwoman/codex/us` in new code.
 */

export { NAME_PRONE_US_SUFFIXES } from "@mailwoman/codex/us"
