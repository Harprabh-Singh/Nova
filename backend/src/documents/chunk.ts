/**
 * Heading-aware chunking. Chunks follow document structure (Markdown headings,
 * numbered clauses, ALL-CAPS headers) so citations can name a real section.
 */

export type Chunk = {
	seq: number
	section: string
	text: string
}

export type ChunkOptions = {
	targetChars: number
	overlapChars: number
}

const HEADING_PATTERNS: RegExp[] = [
	/^#{1,6}\s+(.{3,120})$/, // markdown heading
	/^(\d+(?:\.\d+)*)[.)]?\s+([A-Z][^.]{3,110})$/, // 4.2 Purchase Approval Thresholds
	/^([A-Z][A-Z0-9 &/\-,()]{5,80})$/, // ALL CAPS HEADING
]

export function detectHeading(line: string): string | null {
	const trimmed = line.trim()
	if (!trimmed || trimmed.length > 130) return null
	for (const pattern of HEADING_PATTERNS) {
		const match = pattern.exec(trimmed)
		if (match) {
			return (match[2] ? `${match[1]} ${match[2]}` : match[1]).trim()
		}
	}
	return null
}

/** Also used for document title detection during metadata detection. */
export function firstHeading(text: string): string | null {
	for (const line of text.split(/\r?\n/).slice(0, 30)) {
		const heading = detectHeading(line)
		if (heading) return heading.replace(/^#+\s*/, "")
	}
	return null
}

export function chunkText(text: string, options: ChunkOptions): Chunk[] {
	const lines = text.replace(/\r\n/g, "\n").split("\n")
	type Block = { section: string; lines: string[] }
	const blocks: Block[] = []
	let current: Block = { section: "Introduction", lines: [] }

	for (const line of lines) {
		const heading = detectHeading(line)
		if (heading) {
			if (current.lines.join("\n").trim()) blocks.push(current)
			current = { section: heading, lines: [] }
			continue
		}
		current.lines.push(line)
	}
	if (current.lines.join("\n").trim()) blocks.push(current)
	if (blocks.length === 0) blocks.push({ section: "Document", lines: [text] })

	const chunks: Chunk[] = []
	let seq = 0
	for (const block of blocks) {
		const body = block.lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()
		if (!body) continue
		if (body.length <= options.targetChars) {
			chunks.push({ seq: seq++, section: block.section, text: `${block.section}\n${body}`.trim() })
			continue
		}
		// Split long sections on paragraph boundaries with a small overlap.
		const paragraphs = body.split(/\n{2,}/)
		let buffer = ""
		const flush = () => {
			if (!buffer.trim()) return
			chunks.push({ seq: seq++, section: block.section, text: `${block.section}\n${buffer.trim()}` })
			buffer = options.overlapChars > 0 ? buffer.slice(-options.overlapChars) : ""
		}
		for (const paragraph of paragraphs) {
			if ((buffer + paragraph).length > options.targetChars) flush()
			buffer += `${paragraph}\n\n`
		}
		flush()
	}
	return chunks
}
