import type * as Preset from "@docusaurus/preset-classic"
import type { Config } from "@docusaurus/types"
import { gitSync } from "@mailwoman/core/git"
import { themes as prismThemes } from "prism-react-renderer"

import type { GlossaryPluginOptions } from "./plugins/glossary/plugin.ts"
// Upstream remark auto-linker wrapped with the proper-noun and homonym guards (see plugins/glossary/remark.ts).
import glossaryRemarkPlugin from "./plugins/glossary/remark.ts"
import { createSidebarMegaMenu } from "./plugins/navbar-menus.ts"

/**
 * Surfaces the glossary auto-linker must never link, whatever term claims them.
 *
 * `state` (an alias of `region`) fired on 38 pages and `tier` on 39 in ordinary senses.
 * Suppression is by surface, so `region` still links and a multi-word phrase
 * containing a suppressed word still links in full.
 */
const GLOSSARY_NO_AUTO_LINK = ["state", "tier"] as const

const gitHash = (() => {
	try {
		return gitSync(["rev-parse", "--short", "HEAD"])
	} catch {
		return "unknown"
	}
})()

const buildDate = new Date()
const buildTime = buildDate.toISOString()

// Locale-stable display format, identical on server and client, so no React hydration mismatch.
const buildTimeDisplay = (() => {
	const pad = (n: number) => String(n).padStart(2, "0")
	const Y = buildDate.getUTCFullYear()
	const M = pad(buildDate.getUTCMonth() + 1)
	const D = pad(buildDate.getUTCDate())
	const h = pad(buildDate.getUTCHours())
	const m = pad(buildDate.getUTCMinutes())

	return `${Y}-${M}-${D} ${h}:${m} UTC`
})()

// Docusaurus loads this file as CommonJS through jiti, so `__dirname` is the docs workspace.
const sidebarMegaMenu = createSidebarMegaMenu(__dirname)

const config: Config = {
	customFields: {
		buildCommit: gitHash,
		buildTime,
		buildTimeDisplay,
	},
	title: "Mailwoman",
	tagline: "TypeScript-first address parser + geocoder. No API key — runs in Node and the browser.",
	favicon: "img/favicon-32.png",
	headTags: [
		{
			tagName: "meta",
			attributes: {
				name: "theme-color",
				content: "#00093b",
			},
		},
		{
			tagName: "link",
			attributes: {
				rel: "preconnect",
				// Map label glyphs (SDF ranges) still load from here.
				// The page faces come from @sister.software/fonts.
				href: "https://public.mailwoman.ai",
			},
		},
		{
			tagName: "link",
			attributes: {
				rel: "preconnect",
				href: "https://tiles.mailwoman.ai",
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
		// rspack bundles the site.
		// Both bundlers report maplibre-gl's dynamic `import()` of an expression as a
		// "Critical dependency" warning, so that is not a bundler difference.
		// The persistent cache stays off until a build has been measured with it.
		faster: {
			rspackBundler: true,
			rspackPersistentCache: false,
		},
	},

	url: "https://mailwoman.ai",
	baseUrl: "/",
	trailingSlash: false,

	organizationName: "sister-software",
	projectName: "mailwoman",

	onBrokenLinks: "throw",
	onBrokenAnchors: "throw",

	i18n: {
		defaultLocale: "en",
		locales: ["en"],
	},

	plugins: [
		[
			// `/docs` is `routeBasePath`, not a page, so a reader who trims the path to `/docs` gets a 404.
			// This sends it to the first page of the get-started trio.
			"@docusaurus/plugin-client-redirects",
			{
				redirects: [
					{ from: "/docs", to: "/docs/developers/get-started/what-mailwoman-is" },
					// Pricing moved out of the docs to a page of its own.
					{ from: "/docs/pricing", to: "/pricing" },
					// The license page is the only route that can take money.
					{ from: ["/licensing", "/licenses"], to: "/license" },
				],
			},
		],
		"./plugins/runtime-assets/plugin.ts",
		"./plugins/search-index/plugin.ts",
		[
			// Wraps docusaurus-plugin-glossary with the same validation, tooltips and remark.
			// Adds a custom page with tag filters and a category TOC.
			"./plugins/glossary/plugin.ts",
			{
				glossaryPath: "glossary/glossary.json",
				routePath: "/glossary",
				expandAcronymsOnFirstUse: true,
				autoLinkTerms: true,
				// Same list the remark linker gets, so backlinks and tooltips agree.
				noAutoLink: GLOSSARY_NO_AUTO_LINK,
			} satisfies GlossaryPluginOptions,
		],
	],

	// The Sister Software brand: fonts, the Infima bridge, the classic-theme restyle, footer and code blocks. Its tokens
	// come from @mailwoman/react, the shared tokens with Mailwoman's blue product theme merged in.
	themes: [
		["@sister.software/docusaurus-theme", { tokens: "@mailwoman/react/tokens.css" }],
		"@docusaurus/theme-mermaid",
	],

	markdown: {
		mermaid: true,
	},

	clientModules: ["./src/client/trust-policies.ts"],

	presets: [
		[
			"classic",
			{
				docs: {
					path: "articles",
					routeBasePath: "docs",
					sidebarPath: "./sidebars.ts",
					// Single shared tag registry (also used by the blog and the glossary plugin).
					// Docusaurus resolves this relative to the content dir, hence the "../".
					tags: "../tags.yml",
					onInlineTags: "throw",
					editUrl: "https://github.com/sister-software/mailwoman/tree/main/docs/",
					remarkPlugins: [
						[
							glossaryRemarkPlugin,
							{
								glossaryPath: "glossary/glossary.json",
								routePath: "/glossary",
								siteDir: __dirname,
								noAutoLink: GLOSSARY_NO_AUTO_LINK,
							},
						],
					],
				},
				pages: {
					// Co-located `.ts` helpers are not pages and SSG-fail ("no default export")
					// if routed, so exclude them.
					// The other entries reproduce Docusaurus's defaults.
					exclude: [
						"**/_*.{js,jsx,ts,tsx,md,mdx}",
						"**/_*/**",
						"**/*.test.{js,jsx,ts,tsx}",
						"**/__tests__/**",
						"**/*.ts",
					],
				},
				blog: {
					path: "research",
					routeBasePath: "research",
					tags: "../tags.yml",
					onInlineTags: "throw",
					blogTitle: "Field notes",
					blogDescription: "Iteration notes, ship retrospectives, design log entries.",
					blogSidebarTitle: "All posts",
					blogSidebarCount: "ALL",
					showReadingTime: true,
					postsPerPage: 10,

					feedOptions: {
						type: ["rss", "atom"],
						title: "Mailwoman Research Log",
						copyright: `Copyright © ${new Date().getFullYear()} Sister Software.`,
					},
				},
				sitemap: {
					// Internal utility pages stay reachable but out of the sitemap.
					// Patterns cover both slash forms.
					ignorePatterns: ["/demo", "/demo/", "/debug", "/debug/", "/trace", "/trace/"],
				},
				theme: {
					customCss: ["./src/css/mermaid.css", "./src/css/custom.css"],
				},
			} satisfies Preset.Options,
		],
	],

	themeConfig: {
		// Default og:image / twitter:card for every page.
		// Regenerate via docs/scripts/social-card.html.
		image: "img/social-card.png",
		colorMode: {
			respectPrefersColorScheme: true,
		},
		mermaid: {
			theme: { light: "base", dark: "base" },
			options: {
				fontFamily: '"Go Mono Web", "Go Mono Fallback", monospace',
				flowchart: { htmlLabels: false, curve: "basis", padding: 18 },
				themeVariables: { primaryColor: "#ffffff", lineColor: "#373d40" },
			},
		},
		navbar: {
			// The top row of the bar hides on scroll. The category row below it stays (the shared theme).
			hideOnScroll: true,
			title: "Mailwoman",
			logo: {
				alt: "Mailwoman 〒 hanko seal",
				// Magenta is the design system's primary mark on the navy navbar in both themes.
				// Navy/blue alternatives ship under /img for lighter surfaces.
				src: "img/mailwoman-seal-magenta.svg",
			},
			// The doors, in reading order; `docSidebar` items point at sidebar ids declared in sidebars.ts.
			// Resources follows Docs (the evidence door) and Product leads Docs (the undecided visitor.
			items: [
				sidebarMegaMenu("product", {
					label: "Product",
					descriptions: { Product: "One engine you install rather than call." },
					featured: {
						eyebrow: "Try it",
						title: "Geocode an address in your browser",
						body: "Earth runs the whole engine client-side. Nothing you type leaves the tab.",
						to: "https://earth.mailwoman.ai/",
						linkLabel: "Open Earth",
					},
				}),
				sidebarMegaMenu("solutions", {
					label: "Solutions",
					descriptions: { Solutions: "Start from the problem in front of you." },
					featured: {
						eyebrow: "Pricing",
						title: "Flat pricing, at any volume",
						body: "Move the slider and watch which row moves.",
						to: "/pricing",
						linkLabel: "See the calculator",
					},
				}),
				sidebarMegaMenu("developers", {
					label: "Developers",
					topGroup: "Build",
					looseLabel: "Project",
					descriptions: {
						"Get started": "Installed and parsing in ten minutes.",
						Tutorials: "End-to-end walkthroughs on real data.",
						"How-to guides": "One task, start to finish.",
						Reference: "The APIs, the CLI and the figures.",
						Localization: "Addresses across languages and scripts.",
						"Postal systems": "How addresses work, country by country.",
						Geocoding: "What a geocoder does and how it is judged.",
						"Address intelligence": "How the model reads an address.",
						Project: "Where the project stands and how to get help.",
					},
					footer: { label: "Start here", to: "/docs/developers/get-started/what-mailwoman-is" },
					featured: {
						eyebrow: "Featured",
						title: "Your first ten minutes",
						body: "Install it and geocode an address against your own disk.",
						to: "/docs/developers/get-started/ten-minute-trial",
					},
				}),
				sidebarMegaMenu("resources", {
					label: "Resources",
					looseLabel: "Elsewhere",
					descriptions: {
						Benchmarks: "Every number ships with its command.",
						Compare: "Mailwoman beside the alternatives.",
						OpenStreetMap: "How we credit the map data.",
						Elsewhere: "Write-ups from the work.",
					},
				}),
				sidebarMegaMenu("about", {
					label: "About",
					descriptions: { About: "Who makes Mailwoman and why." },
				}),
				{
					// A page of its own, outside the docs.
					to: "/pricing",
					label: "Pricing",
					position: "left",
				},
				{
					// The call to action, styled as a button rather than a nav label.
					href: "https://earth.mailwoman.ai/",
					label: "Try the geocoder",
					position: "right",
					className: "navbar__cta",
				},
				{
					href: "https://github.com/sister-software/mailwoman",
					label: "GitHub",
					position: "right",
					// A utility key with the GitHub mark (the shared theme's classic.css).
					className: "navbar__item--github",
				},
			],
		},
		footer: {
			links: [
				{
					title: "Try it",
					items: [
						{ label: "Earth", href: "https://earth.mailwoman.ai/" },
						{ label: "Field notes", to: "/research" },
						// /training is a published page with no other route into it.
						{ label: "Training", to: "/training" },
					],
				},
				{
					title: "More",
					items: [
						{ label: "Pricing", to: "/pricing" },
						{ label: "License", to: "/license" },
						{ label: "GitHub", href: "https://github.com/sister-software/mailwoman" },
						{ label: "npm", href: "https://www.npmjs.com/package/mailwoman" },
					],
				},
				{
					title: "Legal",
					items: [
						{
							label: "Inquiries",
							href: "mailto:hello@sister.software?subject=Hello%20Sister...",
						},
						{
							label: "About Sister Software",
							href: "https://sister.software",
						},
						{
							label: "Privacy Policy",
							to: "/privacy",
						},
						{
							label: "Terms of Service",
							to: "/terms-of-service",
						},
					],
				},
			],
			copyright: `© ${new Date().getFullYear()} Nirrius LLC, DBA Sister Software.`,
		},
		prism: {
			// The brand's framed dark code block in both themes (okaidia on --ss-color-code-bg).
			theme: { ...prismThemes.okaidia, plain: { ...prismThemes.okaidia.plain, backgroundColor: "#272823" } },
		},
	} satisfies Preset.ThemeConfig,
}

export default config
