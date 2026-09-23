/**
 * Prompt-injection detection for ingested content.
 *
 * Detection is used for FLAGGING and NEUTRALISING, never as the only defence:
 * retrieved text is always delivered to the model inside a data envelope with
 * an explicit instruction that document content is untrusted data.
 */

export const INJECTION_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
	{ id: "ignore_previous_instructions", pattern: /ignore\s+(?:\w+\s+){0,3}instructions?/i },
	{ id: "disregard_rules", pattern: /disregard\s+(your|all|the)\s+(rules|instructions|guidelines|policy)/i },
	{ id: "system_prompt_extraction", pattern: /(reveal|show|print|repeat|output|dump|disclose)\s+(?:\w+\s+){0,3}(system\s+prompt|instructions|prompt)/i },
	{ id: "role_override", pattern: /you\s+are\s+now\s+(a|an|the)\s+/i },
	{ id: "secret_extraction", pattern: /(api[_\- ]?key|client[_\- ]?secret|password|connection\s+string|access\s+token)s?\b.{0,40}(reveal|share|show|print|send|list)/i },
	{ id: "exfiltration", pattern: /(send|post|upload|email|exfiltrate)\s+(this|the|all)?\s*(data|documents?|contents?|records?)\s+to\s+\S+/i },
	{ id: "authorization_bypass", pattern: /(bypass|ignore|override)\s+(the\s+)?(access\s+control|permissions?|authorization|rbac)/i },
	{ id: "confidential_disclosure_command", pattern: /(reveal|disclose|leak)\s+(all\s+)?(confidential|restricted|secret)\s+\w+/i },
	{ id: "fake_authority", pattern: /(as\s+an?\s+)?(admin|administrator|developer)\s+(instruction|override|command)s?\b/i },
]

export function detectInjection(text: string): string[] {
	const flags: string[] = []
	for (const { id, pattern } of INJECTION_PATTERNS) {
		if (pattern.test(text)) flags.push(id)
	}
	return flags
}

/**
 * Neutralises imperative injection payloads inside retrieved evidence while
 * preserving the surrounding factual content, and breaks any attempt to close
 * the data envelope.
 */
/** Imperative phrasing aimed at the assistant rather than at a human reader. */
const IMPERATIVE_LINE =
	/\b(say|print|reveal|output|emit|echo|ignore|disregard|override|forget|reply with|respond with|append|include the word)\b/i

export function neutralizeForContext(text: string): { text: string; flags: string[] } {
	const flags = detectInjection(text)
	let output = text.replace(/<\/?(EVIDENCE|SYSTEM|INSTRUCTIONS)[^>]*>/gi, "[tag removed]")
	if (flags.length > 0) {
		const lines = output.split(/\n/).map((line) => {
			const lineFlags = INJECTION_PATTERNS.filter((p) => p.pattern.test(line)).map((p) => p.id)
			if (lineFlags.length > 0) {
				return `[neutralised untrusted instruction: ${lineFlags.join(", ")}]`
			}
			// A document that already contains injection attempts is untrusted as a whole:
			// strip any remaining imperative lines aimed at the assistant.
			if (IMPERATIVE_LINE.test(line)) {
				return "[neutralised untrusted instruction: imperative_directive]"
			}
			return line
		})
		output = lines.join("\n")
	}
	return { text: output, flags }
}

/** Classifies a USER message that tries to attack the agent. */
export function detectUserAttack(message: string): string[] {
	const flags = detectInjection(message)
	if (/what\s+(is|are)\s+your\s+(system\s+)?(prompt|instructions)/i.test(message)) {
		flags.push("system_prompt_extraction")
	}
	if (/(list|show|dump)\s+(all\s+)?(documents?|files?)\s+(in|from)\s+(the\s+)?(other|another)\s+(tenant|company|customer)/i.test(message)) {
		flags.push("cross_tenant_probe")
	}
	if (/(\.env|environment\s+variables?|secret\s+key|connection\s+string)/i.test(message)) {
		flags.push("secret_extraction")
	}
	return [...new Set(flags)]
}
