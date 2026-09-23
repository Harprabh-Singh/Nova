import { useCallback, useEffect, useRef, useState } from "react"
import { ConsoleShell } from "../components/console/ConsoleShell.tsx"
import { ConsoleMessage, type MessageMeta } from "../components/console/ConsoleMessage.tsx"
import { ActionPanel } from "../components/console/ActionPanel.tsx"
import { useSession } from "../providers/SessionProvider.tsx"
import { api } from "../services/api.ts"
import { useCharReveal } from "../lib/anim.tsx"
import { stagger, usePipelineStage } from "../lib/motion.tsx"
import { useRevealGroup } from "../lib/console-motion.tsx"
import type { Conversation, Message } from "../types/index.ts"
import { timeAgo } from "../utils/format.ts"
import "../anim.css"
import "../styles/motion-extra.css"
import "../styles/console.css"
import "../styles/console-motion.css"

const SUGGESTIONS = [
	"What is our machine failure procedure?",
	"Can I approve an \u20b980,000 equipment purchase?",
	"How do I report a workplace incident?",
	"What is our annual leave policy?",
	"What is the escalation path for a production failure?",
	"Hi \u2014 what can you do?",
]

/* The assistant holds its waiting state for at least this long, even when the
 * answer was instant, so the retrieval pipeline is legible. */
const MIN_THINKING_MS = 1400

const STAGES = ["Retrieve", "Authorise", "Ground", "Cite"]

/** The waiting state: the actual pipeline, narrated in console language. */
function ThinkingPanel({ active, name }: { active: boolean; name: string }) {
	const stage = usePipelineStage(active, STAGES.length)
	return (
		<div className="wx-msg">
			<div className="wx-msg-who ai">
				<span className="tile" aria-hidden="true">
					{"\u25c6"}
				</span>
				{name}
			</div>
			<div className="wx-think" role="status" aria-live="polite">
				<div className="wx-think-stages">
					{STAGES.map((label, index) => (
						<span
							key={label}
							className={`wx-stage${index < stage ? " is-past" : ""}${index === stage ? " is-now" : ""}`}
						>
							<i>{`0${index + 1}`}</i> {label}
						</span>
					))}
				</div>
				<div className="wx-bar">
					<i style={{ ["--fill" as string]: String((stage + 1) / STAGES.length) } as React.CSSProperties} />
				</div>
				<span className="wx-think-scan" aria-hidden="true" />
			</div>
		</div>
	)
}

/**
 * The assistant. Same rail, same top bar, same ink-and-bone language as every
 * other console screen - it just owns its own transcript scroller and a
 * composer instead of a page headline.
 */
export function ChatPage() {
	const { me } = useSession()
	const [conversations, setConversations] = useState<Conversation[]>([])
	const [conversationId, setConversationId] = useState<string | null>(null)
	const [messages, setMessages] = useState<Message[]>([])
	const [meta, setMeta] = useState<Record<string, MessageMeta>>({})
	const [input, setInput] = useState("")
	const [sending, setSending] = useState(false)
	const [streamingId, setStreamingId] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const endRef = useRef<HTMLDivElement>(null)
	const streamRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLTextAreaElement>(null)
	const titleRef = useRef<HTMLSpanElement>(null)

	const assistantName = me?.tenant.settings.assistantName ?? "NOVA"
	const empty = messages.length === 0
	useCharReveal(titleRef, { delay: 0.06, stagger: 0.02, enabled: empty })
	const railRef = useRevealGroup<HTMLDivElement>(conversations.length)

	// Grow the textarea with its content, up to the CSS max height.
	useEffect(() => {
		const el = inputRef.current
		if (!el) return
		el.style.height = "auto"
		el.style.height = `${Math.min(el.scrollHeight, 168)}px`
	}, [input])

	/* Scroll the transcript container, not the window - the shell is fixed. */
	const scrollToEnd = useCallback((smooth = true) => {
		const container = streamRef.current
		if (!container) return
		container.scrollTo({ top: container.scrollHeight, behavior: smooth ? "smooth" : "auto" })
	}, [])

	const loadConversations = useCallback(async () => {
		try {
			const result = await api.conversations()
			setConversations(result.conversations)
		} catch {
			/* the rail is non-critical */
		}
	}, [])

	useEffect(() => {
		void loadConversations()
	}, [loadConversations, me?.user.id])

	// Switching persona must never leak the previous persona's transcript.
	useEffect(() => {
		setConversationId(null)
		setMessages([])
		setMeta({})
		setStreamingId(null)
	}, [me?.user.id])

	useEffect(() => {
		scrollToEnd()
	}, [messages, sending, scrollToEnd])

	const reset = () => {
		setConversationId(null)
		setMessages([])
		setMeta({})
		setStreamingId(null)
		setError(null)
		inputRef.current?.focus()
	}

	const openConversation = async (id: string) => {
		setError(null)
		setStreamingId(null)
		try {
			const result = await api.conversation(id)
			setConversationId(id)
			setMessages(result.messages)
			setMeta({})
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Could not open that conversation.")
		}
	}

	const send = async (text: string) => {
		const question = text.trim()
		if (!question || sending) return
		setInput("")
		setError(null)
		setSending(true)
		const startedAt = Date.now()
		const optimistic: Message = {
			id: `local-${Date.now()}`,
			conversationId: conversationId ?? "pending",
			role: "user",
			content: question,
			grounding: null,
			confidence: null,
			provider: null,
			latencyMs: null,
			feedback: null,
			citations: [],
			action: null,
			createdAt: new Date().toISOString(),
		}
		setMessages((current) => [...current, optimistic])
		try {
			const response = await api.chat({ message: question, conversationId: conversationId ?? undefined })
			const elapsed = Date.now() - startedAt
			if (elapsed < MIN_THINKING_MS) {
				await new Promise((resolve) => setTimeout(resolve, MIN_THINKING_MS - elapsed))
			}
			setConversationId(response.conversationId)
			setMessages((current) => [...current, response.message])
			setStreamingId(response.message.id)
			setMeta((current) => ({
				...current,
				[response.message.id]: {
					retrieval: response.retrieval,
					security: response.security,
					model: response.model,
					workflow: response.workflow,
				},
			}))
			void loadConversations()
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "The assistant is unavailable right now.")
		} finally {
			setSending(false)
		}
	}

	const firstName = me?.user.name.split(" ")[0] ?? "there"

	/* The history lives inside the shared rail, so the navigation itself never
	 * changes shape between the assistant and the rest of the console. */
	const history = (
		<div className="wx-history" ref={railRef}>
			<div className="wx-label wx-history-label">
				<span>History</span>
				<span>{conversations.length.toString().padStart(2, "0")}</span>
			</div>

			<button className="wx-btn small wx-newconvo" type="button" onClick={reset}>
				New conversation <i aria-hidden="true">&rarr;</i>
			</button>

			<div className="wx-convos">
				{conversations.map((conversation) => (
					<div
						key={conversation.id}
						data-reveal
						className={`wx-convo${conversationId === conversation.id ? " is-active" : ""}`}
					>
						<button
							type="button"
							className="t"
							title={`${conversation.title} \u00b7 updated ${timeAgo(conversation.updatedAt)}`}
							onClick={() => void openConversation(conversation.id)}
						>
							{conversation.title}
						</button>
						<button
							type="button"
							className="x"
							aria-label={`Delete ${conversation.title}`}
							onClick={async () => {
								await api.deleteConversation(conversation.id).catch(() => undefined)
								if (conversationId === conversation.id) {
									setConversationId(null)
									setMessages([])
								}
								void loadConversations()
							}}
						>
							{"\u00d7"}
						</button>
					</div>
				))}
				{conversations.length === 0 ? <div className="wx-empty">No conversations yet</div> : null}
			</div>
		</div>
	)

	return (
		<ConsoleShell bare railExtra={history}>
			<div className="wx-stream" ref={streamRef}>
				<div className="wx-stream-inner">
					{empty ? (
						<div className="wx-welcome">
							<div className="wx-kicker">01 / Assistant</div>
							<h1>
								<span ref={titleRef}>Ask anything.</span> <span className="out">Get proof.</span>
							</h1>
							<p className="wx-lede">
								Hello {firstName} &mdash; every answer here is assembled only from {me?.tenant.name ?? "your"}{" "}
								documents your role is cleared to open, and arrives with the clause it came from. If the evidence is
								not there, {assistantName} says so instead of guessing.
							</p>
							<div className="wx-rule" />
							<div className="wx-suggestions">
								{SUGGESTIONS.map((suggestion, index) => {
									const entrance = stagger(index, 0.06, 0.18)
									return (
										<button
											key={suggestion}
											type="button"
											className={`wx-suggestion ${entrance.className}`}
											style={entrance.style}
											onClick={() => void send(suggestion)}
										>
											<span className="n">{`0${index + 1}`}</span>
											<span>{suggestion}</span>
										</button>
									)
								})}
							</div>
						</div>
					) : (
						messages.map((message) => (
							<ConsoleMessage
								key={message.id}
								message={message}
								meta={meta[message.id]}
								stream={message.id === streamingId}
								onStreamTick={() => scrollToEnd(false)}
								onStreamDone={() => setStreamingId((current) => (current === message.id ? null : current))}
							/>
						))
					)}

					{sending ? <ThinkingPanel active={sending} name={assistantName} /> : null}
					{error ? (
						<div className="wx-alert" role="alert">
							{error}
						</div>
					) : null}
					<div ref={endRef} />
				</div>
			</div>

			<div className="wx-composer">
				{/* Phase 8. Governed actions live beside the composer, not inside the
				    transcript: a write into an enterprise system is an explicit,
				    two-step decision, not something a sentence can trigger. */}
				<ActionPanel conversationId={conversationId} />
				<div className="wx-composer-inner">
					<textarea
						ref={inputRef}
						rows={1}
						value={input}
						aria-label={`Message ${assistantName}`}
						placeholder={`Ask ${assistantName} about a policy, a procedure or an approval\u2026`}
						onChange={(event) => setInput(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault()
								void send(input)
							}
						}}
					/>
					<button
						className="wx-send"
						type="button"
						aria-label="Send message"
						disabled={sending || !input.trim()}
						onClick={() => void send(input)}
					>
						<svg
							width="17"
							height="17"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2.4"
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
						>
							<path d="M12 19V5" />
							<path d="m5 12 7-7 7 7" />
						</svg>
					</button>
				</div>
				<div className="wx-composer-foot">
					<span>Enter to send &middot; Shift + Enter for a new line</span>
					<span>Answers cite only documents you may open</span>
				</div>
			</div>
		</ConsoleShell>
	)
}

export default ChatPage
// hist: 2026-09-23T22:33:43+05:30
