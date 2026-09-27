/**
 * Minimal ambient declaration for js-yaml (hoisted from @docusaurus/core. No @types package installed).
 *
 * Only the surface plugin.ts uses.
 */
declare module "js-yaml" {
	export function load(input: string): unknown
}
