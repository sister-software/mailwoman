// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The browser runtime: what a host needs to load one published release into a working geocoder in a browser, from
 *   the public data origin. The Node counterpart is `createRuntimePipeline`; this composes the same packages for the
 *   client. It is the one module here that a bundler must be able to build under the `browser` condition.
 */

export { loadReleaseAssets } from "#browser-runtime/load-assets"
export { fetchReleasesManifest } from "#browser-runtime/manifest"
