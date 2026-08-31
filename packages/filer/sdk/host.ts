/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Hostname handling shared by the filer HTTP clients' allowlists — the implementation moved to
 *   `@mailwoman/core/api` so every designated client shares one, and this module re-exports it so existing
 *   imports keep reading the same.
 */

export { canonicalHostname } from "@mailwoman/core/api"
