import type * as Preset from "@docusaurus/preset-classic"
import type { Config } from "@docusaurus/types"
import { execSync } from "node:child_process"
import { themes as prismThemes } from "prism-react-renderer"

const gitHash = (() => {
	try {
		return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim()
	} catch {
		return "unknown"
	}
})()

const buildDate = new Date()
const buildTime = buildDate.toISOString()
// Locale-stable display format: "2026-05-28 02:42 UTC". Same string on server and client,
// so no React hydration mismatch.
const buildTimeDisplay = (() => {
	const pad = (n: number) => String(n).padStart(2, "0")
	const Y = buildDate.getUTCFullYear()
	const M = pad(buildDate.getUTCMonth() + 1)
	const D = pad(buildDate.getUTCDate())
	const h = pad(buildDate.getUTCHours())
	const m = pad(buildDate.getUTCMinutes())
	return `${Y}-${M}-${D} ${h}:${m} UTC`
})()

const config: Config = {
	customFields: {
		buildCommit: gitHash,
		buildTime,
		buildTimeDisplay,
	},
	title: "Mailwoman",
	tagline: "TypeScript-first address parser + geocoder. Runs in Node and the browser.",
	favicon: "img/favicon-32.png",
	headTags: [
		{
			tagName: "meta",
			attributes: {
				"theme-color": "#00093b",
			},
		},
		{
			tagName: "link",
			attributes: {
				rel: "preconnect",
				href: "https://public.sister.software",
			},
		},
		{
			tagName: "link",
			attributes: {
				rel: "preconnect",
				href: "https://tiles.sister.software",
			},
		},
		{
			tagName: "link",
			attributes: {
				rel: "preconnect",
				href: "https://elevation-tiles-prod.s3.amazonaws.com",
			},
		},
	],

	future: {
		v4: true,
		// @docusaurus/faster is installed but its rspack bundler chokes on `node:` prefixed imports
		// from isomorphic deps (sentencepiece-js, onnxruntime-web). Explicitly disable so standard
		// webpack stays in charge. The other speedups (swc loader / minimizer, lightningcss, mdx
		// cache) are stable on this build and worth keeping.
		faster: {
			rspackBundler: false,
			rspackPersistentCache: false,
		},
	},

	url: "https://mailwoman.sister.software",
	baseUrl: "/",

	organizationName: "sister-software",
	projectName: "mailwoman",

	onBrokenLinks: "throw",

	i18n: {
		defaultLocale: "en",
		locales: ["en"],
	},

	plugins: ["./plugins/demo-assets/plugin.mjs"],

	themes: ["@docusaurus/theme-mermaid"],

	markdown: {
		mermaid: true,
	},

	presets: [
		[
			"classic",
			{
				docs: {
					path: "articles",
					routeBasePath: "docs",
					sidebarPath: "./sidebars.ts",
					editUrl: "https://github.com/sister-software/mailwoman/tree/main/docs/",
				},
				blog: {
					path: "blog",
					routeBasePath: "blog",
					blogTitle: "Mailwoman log",
					blogDescription: "Iteration notes, ship retrospectives, design log entries.",
					showReadingTime: true,
					postsPerPage: 10,
					feedOptions: {
						type: ["rss", "atom"],
						title: "Mailwoman log",
						copyright: `Copyright © ${new Date().getFullYear()} Sister Software.`,
					},
				},
				theme: {
					customCss: [
						// ---
						"./src/css/fonts/IosevkaNexus.css",
						"./src/css/fonts/IosevkaNexusMono.css",
						"./src/css/theme-light.css",
						"./src/css/theme-dark.css",
						"./src/css/markdown.css",
						"./src/css/custom.css",
					],
				},
			} satisfies Preset.Options,
		],
	],

	themeConfig: {
		colorMode: {
			respectPrefersColorScheme: true,
		},
		navbar: {
			title: "Mailwoman",
			logo: {
				alt: "Mailwoman 〒 hanko seal",
				// Magenta seal on the navy navbar in both themes — the design system
				// brief calls magenta the primary mark; navy/blue alts ship under
				// /img for use on lighter surfaces.
				src: "img/mailwoman-seal-magenta.svg",
			},
			items: [
				{
					to: "/demo",
					label: "Demo",
					position: "left",
				},
				{
					type: "docSidebar",
					sidebarId: "tutorialSidebar",
					position: "left",
					label: "Docs",
				},
				{
					to: "/blog",
					label: "Log",
					position: "left",
				},
				{
					href: "https://github.com/sister-software/mailwoman",
					label: "GitHub",
					position: "right",
				},
			],
		},
		footer: {
			style: "dark",
			links: [
				{
					title: "Try it",
					items: [
						{ label: "Demo", to: "/demo" },
						{ label: "Log", to: "/blog" },
					],
				},
				{
					title: "Docs",
					items: [
						{ label: "Plan", to: "/docs/plan" },
						{ label: "Eval reports", to: "/docs/evals/stage1-coarse-v0.1.0-vs-golden-v0.1.2" },
						{ label: "Retrospectives", to: "/docs/retrospectives" },
					],
				},
				{
					title: "More",
					items: [
						{ label: "GitHub", href: "https://github.com/sister-software/mailwoman" },
						{ label: "npm", href: "https://www.npmjs.com/package/mailwoman" },
					],
				},
			],
			copyright: `Copyright © ${new Date().getFullYear()} Sister Software.`,
		},
		prism: {
			theme: prismThemes.github,
			darkTheme: prismThemes.dracula,
		},
	} satisfies Preset.ThemeConfig,
}

export default config
