/**
 * Smalltalk engine — makes the assistant behave like a real chatbot.
 *
 * Retrieval-augmented systems are typically great at policy questions and
 * terrible at being a conversation partner: "hi" gets routed into vector
 * search and comes back as "I couldn't verify this…", which feels broken.
 * This module detects conversational turns — including casual slang like
 * "wyd", "sup", "lol", "k" — and answers them directly, without touching
 * retrieval. Deterministic, tenant-aware, never fabricates knowledge claims.
 */
import type { Database } from "../db/index.ts"
import type { Tenant, User } from "../models/types.ts"

export type SmalltalkIntent =
	| "greeting"
	| "farewell"
	| "thanks"
	| "how_are_you"
	| "identity"
	| "capabilities"
	| "affirm"
	| "negate"
	| "casual"
	| "nature"
	| "compliment"
	| "apology"

const MAX_SMALLTALK_WORDS = 12

function wordCount(text: string): number {
	return text.split(/\s+/).filter(Boolean).length
}

/**
 * Normalise a conversational turn before matching.
 *
 * Real people do not type bare keywords: they type "hello nova", "hey there!",
 * "good morning NOVA :)", "thanks a lot buddy". Those used to fall straight
 * through to vector search - which is why "hello nova" came back as a failed
 * document lookup while "hi" worked fine. Strip everything that carries no
 * intent (the assistant's own name, vocatives, politeness fillers, emoji,
 * punctuation) and match on what is left.
 */
export function normalizeTurn(message: string, assistantName = "NOVA"): string {
	let text = message
		.toLowerCase()
		.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, " ")
		.replace(/[!?.,;:~\-\u2014\u2013"'`()\[\]]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()

	const assistant = assistantName.toLowerCase().replace(/[^a-z0-9]/g, "")
	const vocatives = [assistant, "nova", "bot", "assistant", "buddy", "mate", "bro", "dude", "sir", "maam", "madam", "there", "everyone", "team", "guys", "folks"].filter(Boolean)
	for (const word of vocatives) {
		text = text.replace(new RegExp(`(^|\\s)${word}(?=\\s|$)`, "g"), " ")
	}

	return text
		.replace(/\b(please|pls|plz|kindly|just|quick|quickly|btw)\b/g, " ")
		.replace(/\s+/g, " ")
		.trim()
}

/** Detect a conversational turn. Conservative about length, so real knowledge
 *  questions that happen to contain "thanks" are never hijacked. */
export function detectSmalltalk(message: string, assistantName = "NOVA"): SmalltalkIntent | null {
	const text = normalizeTurn(message, assistantName)
	if (!text) return null
	const words = wordCount(text)

	if (words <= MAX_SMALLTALK_WORDS) {
		// Greetings — broad coverage incl. slang and time-of-day variants.
		if (/^(hi+|hii+|hello+|hey+|heyy+|yo|hola|namaste|namaskar|greetings|howdy|hiya|hullo)\b(\s+(again|back|all|folks|good\s(morning|afternoon|evening)))?$/.test(text))
			return "greeting"
		if (/^good\s(morning|afternoon|evening|day|night)\b.{0,12}$|^(gm|gn|gd mrng|gud morning|gud evening)\b.{0,12}$/.test(text)) return "greeting"
		if (/^(salaam|salut|bonjour|namaste ji|vanakkam|kem cho|sat sri akal)\b[!.,\s]*$/.test(text)) return "greeting"

		// Farewells.
		if (/^(bye+|goodbye|see\syou|see\sya|see ya|gtg|got to go|talk later|catch you later|brb|be right back|good\s?night|goodnight|tc|take care)\b/.test(text)) return "farewell"

		// Thanks.
		if (/^(thanks|thank\syou|thankyou|thx|ty|tysm|appreciated?|much\sappreciated|thanks a lot|thank u|thnx|dhanyavad|shukriya)\b/.test(text) && words <= 8) return "thanks"

		// Short acknowledgements.
		if (/^(yes|yeah|yep|yup|ya|sure|ok|okay|kk|k|okie|sounds good|please do|go ahead|cool|nice|great|awesome|perfect|alright|aight|fine|got it|understood|makes sense)[!.\s]*$/.test(text)) return "affirm"
		if (/^(no|nope|nah|not really|no thanks|no thank you|nvm|nevermind|never mind|na|nahi)[!.\s]*$/.test(text)) return "negate"

		// Compliments.
		if (/(you('re| are) (awesome|amazing|great|smart|the best|helpful|cool)|good job|well done|nice (work|one)|i like you|love (it|this|you)|impressive|that was helpful)/.test(text)) return "compliment"

		// Apologies.
		if (/^(sorry|my bad|oops|sry|apologies|forgive me)\b/.test(text) && words <= 8) return "apology"

		// Casual slang / chit-chat — the stuff a real chatbot must survive.
		if (/^(wyd|wud|sup|wassup|whassup|what'?s up|whats up|what up|hru|hbu|wbu|how about you|how's life|hows life)\??[!.\s]*$/.test(text)) return "casual"
		if (/^(lol+|lmao+|haha+|hehe+|hmm+|hm+|ohh*|wow+|omg|sheesh|damn|ugh|meh|phew|yay+|woohoo|lolol)[!.\s]*$/.test(text)) return "casual"
		if (/^(idk|dunno|no idea|bored|i'?m bored|boring|busy|tired|sleepy|hungry)[!.\s]*$/.test(text)) return "casual"
		if (/what (are|r) (you|u) (doing|upto|up to)|whatcha doing|what'?s happening|what'?s going on/.test(text) && words <= 8) return "casual"
		if (/^(nothing much|nm|just chilling|chilling|same old|all good)[!.\s]*$/.test(text)) return "casual"

		// Questions about the assistant's nature.
		if (/(are you (real|ai|a robot|human|a bot|alive|an ai|single|free)|who (made|created|built|owns) you|do you (sleep|eat|feel|think|dream)|tell me a joke|are you smart|how smart are you|how old are you|where do you live)/.test(text)) return "nature"
	}

	if (/how\s(are|r)\s?(you|u)|how's it going|how is it going|how do you feel|how'?s your (day|life|week)|how have you been/.test(text) && words <= 10) {
		return "how_are_you"
	}
	if (/(who are you|what are you|your name|about yourself|what is nova|what's nova|whats nova|introduce yourself|tell me about yourself)/.test(text) && words <= 12) {
		return "identity"
	}
	if (
		/(what can you do|what all can you do|how can you help|what do you do|help me|can you help|what are you (able|capable)|show me what|capabilities|^help$|^menu$|what topics|what do you know)/.test(
			text,
		) &&
		words <= 12
	) {
		return "capabilities"
	}

	return null
}

function sampleDepartments(db: Database, tenantId: string): string[] {
	try {
		return db
			.all(`SELECT DISTINCT department FROM documents WHERE tenant_id = ? AND status = 'active' ORDER BY department`, tenantId)
			.map((r) => String(r.department))
			.filter(Boolean)
			.slice(0, 6)
	} catch {
		return []
	}
}

function firstName(user: User): string {
	return user.name.split(/\s+/)[0] || user.name
}

function timeGreeting(): string {
	const hour = new Date().getHours()
	if (hour < 12) return "Good morning"
	if (hour < 17) return "Good afternoon"
	return "Good evening"
}

function capabilitiesList(db: Database, tenant: Tenant, user: User): string[] {
	const departments = sampleDepartments(db, tenant.id)
	const items = [
		`Answer questions about ${tenant.name}'s policies, SOPs and guidelines — with citations to the exact document and section.`,
		"Check approval limits, expense rules, leave entitlements and escalation paths.",
		"Help you report a machine or workplace incident step by step.",
	]
	if (departments.length > 0) {
		items.push(`You currently have access to: ${departments.join(", ")} — access is enforced per role, so answers only use documents you're cleared to see.`)
	}
	return items
}

/** Compose a warm, persona-consistent reply for a conversational turn. */
export function smalltalkReply(db: Database, tenant: Tenant, user: User, intent: SmalltalkIntent): string {
	const assistant = tenant.settings.assistantName || "NOVA"
	const name = firstName(user)

	switch (intent) {
		case "greeting":
			return [
				`${timeGreeting()}, ${name}! 👋 I'm ${assistant}, the ${tenant.name} knowledge assistant.`,
				"",
				`Ask me anything about company policies, SOPs, approvals or benefits — or say "what can you do" to see what's possible.`,
			].join("\n")
		case "farewell":
			return `Goodbye, ${name}! I'm here whenever you need an answer. Have a great day.`
		case "thanks":
			return `You're very welcome, ${name}! If anything else comes up — a policy, a procedure, an approval limit — just ask.`
		case "how_are_you":
			return [
				`Doing well, thanks for asking! Fully indexed and ready to answer. 🙂`,
				"",
				`What can I help you with today, ${name}?`,
			].join("\n")
		case "identity":
			return [
				`I'm ${assistant} — ${tenant.name}'s knowledge assistant.`,
				"",
				"I don't guess: every answer I give is retrieved at question time from your company's own documents, filtered by your role and permissions, and backed by citations you can check. I can also help you report incidents.",
			].join("\n")
		case "capabilities": {
			const items = capabilitiesList(db, tenant, user)
			return [`Here's what I can do for you, ${name}:`, "", ...items.map((i) => `• ${i}`), "", "Just type a question in plain language to get started."].join("\n")
		}
		case "affirm":
			return `Great — go ahead and ask your question whenever you're ready, ${name}.`
		case "negate":
			return "No problem! I'm here if you need anything later."
		case "compliment":
			return `That means a lot, ${name} — thank you! 😊 Happy to help whenever you need a policy, procedure or approval answer.`
		case "apology":
			return "No need to apologize at all! Ask me anything — I'm here to help."
		case "casual":
			return [
				`Just here and ready to help, ${name} 🙂`,
				"",
				`I'm at my best with work questions — policies, leave, approvals, SOPs, incident reports. What's on your mind?`,
			].join("\n")
		case "nature":
			return [
				`I'm an AI — ${assistant}, built into ${tenant.name}'s knowledge platform. Not human, but I do know the company handbook inside out.`,
				"",
				"The difference between me and a generic chatbot: I only answer from your company's actual documents, and I show my sources.",
			].join("\n")
	}
}
