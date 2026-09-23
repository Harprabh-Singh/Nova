/** Tiny HTTP helpers built on node:http. No framework dependency. */
import type { IncomingMessage, ServerResponse } from "node:http"

export type Ctx = {
	req: IncomingMessage
	res: ServerResponse
	url: URL
	params: Record<string, string>
	requestId: string
}

export class HttpError extends Error {
	constructor(
		readonly statusCode: number,
		message: string,
		readonly code = "error",
	) {
		super(message)
		this.name = "HttpError"
	}
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body)
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(payload),
		"cache-control": "no-store",
	})
	res.end(payload)
}

export const MAX_BODY_BYTES = 20 * 1024 * 1024

export async function readBody(req: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = []
	let total = 0
	for await (const chunk of req) {
		const buf = chunk as Buffer
		total += buf.byteLength
		if (total > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large", "payload_too_large")
		chunks.push(buf)
	}
	return Buffer.concat(chunks)
}

export async function readJson<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
	const body = await readBody(req)
	if (body.byteLength === 0) return {} as T
	try {
		return JSON.parse(body.toString("utf8")) as T
	} catch {
		throw new HttpError(400, "Malformed JSON body", "malformed_request")
	}
}

export type MultipartFile = { field: string; filename: string; contentType: string; data: Buffer }
export type MultipartResult = { fields: Record<string, string>; files: MultipartFile[] }

/** Minimal multipart/form-data parser for local document uploads. */
export function parseMultipart(body: Buffer, contentType: string): MultipartResult {
	const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
	const boundary = match?.[1] ?? match?.[2]
	if (!boundary) throw new HttpError(400, "Missing multipart boundary", "malformed_request")
	const delimiter = Buffer.from(`--${boundary}`)
	const result: MultipartResult = { fields: {}, files: [] }

	let index = body.indexOf(delimiter)
	if (index === -1) throw new HttpError(400, "Malformed multipart body", "malformed_request")
	index += delimiter.length

	while (index < body.length) {
		if (body.slice(index, index + 2).toString() === "--") break
		if (body.slice(index, index + 2).toString() === "\r\n") index += 2
		const headerEnd = body.indexOf("\r\n\r\n", index)
		if (headerEnd === -1) break
		const headerText = body.slice(index, headerEnd).toString("utf8")
		const next = body.indexOf(delimiter, headerEnd)
		const partEnd = next === -1 ? body.length : next - 2
		const data = body.slice(headerEnd + 4, partEnd)

		const nameMatch = /name="([^"]*)"/i.exec(headerText)
		const fileMatch = /filename="([^"]*)"/i.exec(headerText)
		const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(headerText)
		const field = nameMatch?.[1] ?? ""
		if (fileMatch && fileMatch[1]) {
			result.files.push({
				field,
				filename: fileMatch[1],
				contentType: (typeMatch?.[1] ?? "application/octet-stream").trim(),
				data,
			})
		} else if (field) {
			result.fields[field] = data.toString("utf8")
		}
		if (next === -1) break
		index = next + delimiter.length
	}
	return result
}

export type Handler = (ctx: Ctx) => Promise<void> | void
type Route = { method: string; pattern: string[]; handler: Handler }

export class Router {
	private readonly routes: Route[] = []

	add(method: string, path: string, handler: Handler): void {
		this.routes.push({ method, pattern: path.split("/").filter(Boolean), handler })
	}

	get(path: string, handler: Handler) {
		this.add("GET", path, handler)
	}
	post(path: string, handler: Handler) {
		this.add("POST", path, handler)
	}
	patch(path: string, handler: Handler) {
		this.add("PATCH", path, handler)
	}
	delete(path: string, handler: Handler) {
		this.add("DELETE", path, handler)
	}

	match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
		const segments = pathname.split("/").filter(Boolean)
		for (const route of this.routes) {
			if (route.method !== method || route.pattern.length !== segments.length) continue
			const params: Record<string, string> = {}
			let ok = true
			for (let i = 0; i < route.pattern.length; i += 1) {
				const part = route.pattern[i]
				if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(segments[i])
				else if (part !== segments[i]) {
					ok = false
					break
				}
			}
			if (ok) return { handler: route.handler, params }
		}
		return null
	}
}
