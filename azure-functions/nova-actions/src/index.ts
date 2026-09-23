/**
 * NOVA Actions - Azure Functions v4 (Node programming model) entry point.
 *
 * This file is deliberately thin: it registers three HTTP triggers and adapts
 * each request into a call to the pure handlers in ./handlers.ts. All
 * behaviour, validation and error shaping lives there, which is why the unit
 * tests need neither the Functions host nor a storage account.
 *
 * AUTHENTICATION
 * --------------
 * authLevel is "function": the caller must present a function key
 * (x-functions-key). That key is held by the NOVA backend in
 * AZURE_ACTION_FUNCTION_KEY and is never sent to a browser. For production,
 * front this app with API Management or an Entra-protected App Service
 * authentication policy as well - the key alone is a shared secret, and a
 * shared secret is not an identity.
 *
 * ROUTES (with host.json routePrefix "api"):
 *   POST /api/actions/create-it-request
 *   POST /api/actions/submit-approval
 *   POST /api/actions/create-onboarding-checklist
 */
import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions"

import { ACTION_ROUTES, handle, type ActionRoute } from "./handlers.js"

/** 256 KiB is far above any legitimate action payload and well below abuse. */
const MAX_BODY_BYTES = 256 * 1024

async function readJsonBody(request: HttpRequest): Promise<unknown> {
	const text = await request.text()
	if (text.length > MAX_BODY_BYTES) throw new Error("payload_too_large")
	if (!text) return {}
	return JSON.parse(text)
}

function respond(route: ActionRoute, payload: unknown): HttpResponseInit {
	const result = handle(route, payload)
	return {
		status: result.status,
		jsonBody: result.body,
		headers: { "cache-control": "no-store" },
	}
}

function register(route: ActionRoute): void {
	app.http(route, {
		methods: ["POST"],
		authLevel: "function",
		route: `actions/${route}`,
		handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
			let payload: unknown
			try {
				payload = await readJsonBody(request)
			} catch (error) {
				const tooLarge = (error as Error).message === "payload_too_large"
				context.warn(`rejected ${route} request: ${tooLarge ? "payload too large" : "malformed JSON"}`)
				return {
					status: tooLarge ? 413 : 400,
					jsonBody: {
						ok: false,
						error: {
							code: "invalid_input",
							message: tooLarge ? "The request body is too large." : "The request body is not valid JSON.",
						},
					},
				}
			}
			const response = respond(route, payload)
			// Log the outcome, never the payload: action inputs contain personal
			// data (new hire names and emails, justifications).
			context.log(`${route} -> HTTP ${response.status}`)
			return response
		},
	})
}

for (const route of ACTION_ROUTES) register(route)
