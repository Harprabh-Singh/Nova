// Bundles the React frontend with esbuild (no network required).
import { build, context } from "esbuild"
import fs from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const outdir = path.join(root, "frontend/dist")
fs.mkdirSync(outdir, { recursive: true })
fs.copyFileSync(path.join(root, "frontend/index.html"), path.join(outdir, "index.html"))

// Copy static assets (hero animation frames, images, fonts) from frontend/public.
const publicDir = path.join(root, "frontend/public")
if (fs.existsSync(publicDir)) {
	fs.cpSync(publicDir, outdir, { recursive: true })
	console.log("copied frontend/public -> frontend/dist")
}

/**
 * Public Entra configuration for the browser bundle.
 *
 * These are configuration values, NOT secrets: client id, tenant id,
 * authority, API scope and redirect URI. They are only a FALLBACK - at runtime
 * the SPA reads the same values from the backend's GET /api/auth/config, so a
 * deployment normally needs no rebuild to change them. No client secret is
 * ever read or emitted here.
 */
const entraPublic = {
	clientId: process.env.VITE_ENTRA_CLIENT_ID ?? "",
	tenantId: process.env.VITE_ENTRA_TENANT_ID ?? "",
	authority: process.env.VITE_ENTRA_AUTHORITY ?? "",
	apiScope: process.env.VITE_ENTRA_API_SCOPE ?? "",
	redirectUri: process.env.VITE_ENTRA_REDIRECT_URI ?? "",
}

/**
 * @azure/msal-browser is only needed for AUTH_MODE=entra. A local/demo build
 * must not fail (or require network access) when it is not installed, so the
 * import resolves to a stub that fails loudly at runtime instead.
 */
const msalInstalled = fs.existsSync(path.join(root, "node_modules/@azure/msal-browser/package.json"))
const msalStubPlugin = {
	name: "msal-optional",
	setup(build) {
		if (msalInstalled) return
		build.onResolve({ filter: /^@azure\/msal-browser$/ }, () => ({
			path: path.join(root, "frontend/src/auth/msalMissing.ts"),
		}))
	},
}
if (!msalInstalled) {
	console.warn("@azure/msal-browser is not installed - building without Microsoft Entra sign-in (AUTH_MODE=demo only). Run `npm install` to enable it.")
}

const options = {
	entryPoints: [path.join(root, "frontend/src/main.tsx")],
	bundle: true,
	format: "esm",
	target: ["es2022"],
	jsx: "automatic",
	sourcemap: true,
	minify: !process.argv.includes("--watch"),
	outdir,
	entryNames: "app",
	loader: { ".svg": "dataurl" },
	// Root-absolute url() references in CSS are served at runtime from
	// frontend/public (copied to dist above), so esbuild must not resolve them.
	external: ["/assets/*", "/frames/*", "/fonts/*"],
	plugins: [msalStubPlugin],
	define: {
		__VITE_ENTRA__: JSON.stringify(entraPublic),
	},
	logLevel: "info",
}

if (process.argv.includes("--watch")) {
	const ctx = await context(options)
	await ctx.watch()
	console.log("watching frontend...")
} else {
	await build(options)
	console.log(`frontend built -> ${path.relative(root, outdir)}`)
}
