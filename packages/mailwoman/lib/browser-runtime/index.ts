/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The browser runtime: what a host needs to load one published release into a working geocoder in a browser, from
 *   the public data origin. The Node counterpart is `createRuntimePipeline`; this composes the same packages for the
 *   client, and it is the one module here that a bundler must be able to build under the `browser` condition.
 */

export { loadReleaseAssets } from "#browser-runtime/load-assets"
export { fetchReleasesManifest } from "#browser-runtime/manifest"
