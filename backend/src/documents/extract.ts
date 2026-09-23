/**
 * Text extraction for the supported source types. Dependency-free:
 *  - .md / .txt : UTF-8 decode
 *  - .docx      : unzip (raw + deflate) word/document.xml, strip XML
 *  - .pdf       : parse content streams (FlateDecode or raw) and pull text
 *                 show operators. Works for text-based PDFs; scanned PDFs are
 *                 rejected with a clear error instead of silently indexing junk.
 */
import { inflateRawSync, inflateSync } from "node:zlib"

export type ExtractResult = {
	text: string
	sourceType: "markdown" | "text" | "docx" | "pdf"
	warnings: string[]
}

export class UnsupportedFileError extends Error {
	constructor(extension: string) {
		super(`Unsupported file type "${extension}". Supported: .md, .markdown, .txt, .docx, .pdf`)
		this.name = "UnsupportedFileError"
	}
}

export class ExtractionError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "ExtractionError"
	}
}

export function extensionOf(filename: string): string {
	const match = /\.([A-Za-z0-9]+)$/.exec(filename)
	return match ? `.${match[1].toLowerCase()}` : ""
}

export function extractText(filename: string, buffer: Buffer): ExtractResult {
	const extension = extensionOf(filename)
	switch (extension) {
		case ".md":
		case ".markdown":
			return { text: decodeUtf8(buffer), sourceType: "markdown", warnings: [] }
		case ".txt":
			return { text: decodeUtf8(buffer), sourceType: "text", warnings: [] }
		case ".docx":
			return { text: extractDocx(buffer), sourceType: "docx", warnings: [] }
		case ".pdf":
			return extractPdf(buffer)
		default:
			throw new UnsupportedFileError(extension || "(none)")
	}
}

function decodeUtf8(buffer: Buffer): string {
	const text = buffer.toString("utf8").replace(/\u0000/g, "")
	if (!text.trim()) throw new ExtractionError("The file contains no readable text.")
	return text
}

/* ------------------------------- DOCX ----------------------------------- */

type ZipEntry = { name: string; data: Buffer }

/** Minimal ZIP reader supporting stored (0) and deflated (8) entries. */
export function readZipEntries(buffer: Buffer): ZipEntry[] {
	const entries: ZipEntry[] = []
	let offset = 0
	while (offset + 4 <= buffer.length) {
		const signature = buffer.readUInt32LE(offset)
		if (signature !== 0x04034b50) break
		const method = buffer.readUInt16LE(offset + 8)
		const compressedSize = buffer.readUInt32LE(offset + 18)
		const nameLength = buffer.readUInt16LE(offset + 26)
		const extraLength = buffer.readUInt16LE(offset + 28)
		const name = buffer.toString("utf8", offset + 30, offset + 30 + nameLength)
		const dataStart = offset + 30 + nameLength + extraLength
		if (compressedSize === 0 && method === 8) break // streamed entry, unsupported
		const raw = buffer.subarray(dataStart, dataStart + compressedSize)
		try {
			entries.push({ name, data: method === 8 ? inflateRawSync(raw) : Buffer.from(raw) })
		} catch {
			// Skip unreadable entry; document.xml failure is reported by the caller.
		}
		offset = dataStart + compressedSize
	}
	return entries
}

export function extractDocx(buffer: Buffer): string {
	const entries = readZipEntries(buffer)
	const document = entries.find((e) => e.name === "word/document.xml")
	if (!document) throw new ExtractionError("Not a valid .docx package (word/document.xml missing).")
	const xml = document.data.toString("utf8")
	const text = xml
		.replace(/<w:tab[^>]*\/>/g, "\t")
		.replace(/<\/w:p>/g, "\n")
		.replace(/<w:br[^>]*\/>/g, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
	if (!text) throw new ExtractionError("The .docx file contains no readable text.")
	return text
}

/* -------------------------------- PDF ----------------------------------- */

function decodePdfString(raw: string): string {
	return raw
		.replace(/\\([nrt])/g, (_m, c) => ({ n: "\n", r: "\n", t: "\t" })[c as "n" | "r" | "t"]!)
		.replace(/\\([()\\])/g, "$1")
		.replace(/\\([0-7]{1,3})/g, (_m, oct) => String.fromCharCode(parseInt(oct, 8)))
}

export function extractPdf(buffer: Buffer): ExtractResult {
	const warnings: string[] = []
	const streams: string[] = []
	const marker = Buffer.from("stream")
	let index = buffer.indexOf(marker)
	while (index !== -1) {
		let start = index + marker.length
		if (buffer[start] === 0x0d) start += 1
		if (buffer[start] === 0x0a) start += 1
		const end = buffer.indexOf(Buffer.from("endstream"), start)
		if (end === -1) break
		const chunk = buffer.subarray(start, end)
		try {
			streams.push(inflateSync(chunk).toString("latin1"))
		} catch {
			try {
				streams.push(inflateRawSync(chunk).toString("latin1"))
			} catch {
				streams.push(chunk.toString("latin1"))
			}
		}
		index = buffer.indexOf(marker, end)
	}

	const pieces: string[] = []
	for (const stream of streams) {
		// Tj / ' / " single strings
		for (const match of stream.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*(?:Tj|'|")/g)) {
			pieces.push(decodePdfString(match[1]))
		}
		// TJ arrays
		for (const match of stream.matchAll(/\[((?:[^\][\\]|\\.)*)\]\s*TJ/g)) {
			const parts = [...match[1].matchAll(/\(((?:[^()\\]|\\.)*)\)/g)].map((m) => decodePdfString(m[1]))
			if (parts.length) pieces.push(parts.join(""))
		}
		if (/\bTD\b|\bTd\b|\bT\*/.test(stream)) pieces.push("\n")
	}

	const text = pieces
		.join(" ")
		.replace(/[ \t]{2,}/g, " ")
		.replace(/\s*\n\s*/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()

	if (text.length < 40) {
		throw new ExtractionError(
			"No extractable text layer found in this PDF. Scanned/image PDFs need OCR before ingestion.",
		)
	}
	if (streams.length === 0) warnings.push("PDF had no decodable content streams; extraction may be partial.")
	return { text, sourceType: "pdf", warnings }
}
