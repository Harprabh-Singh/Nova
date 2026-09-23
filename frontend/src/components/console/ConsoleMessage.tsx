import { useEffect, useRef, useState } from "react"
import { api } from "../../services/api.ts"
import { useSession } from "../../providers/SessionProvider.tsx"
import type { ChatResponse, Message } from "../../types/index.ts"
import { stagger, useMagnet } from "../../lib/motion.tsx"
import { Stamp } from "./ConsoleShell.tsx"
import { EvidenceHeader, MetadataRow, StatusMark, TechnicalLabel, TraceHeader } from "../shared/system.tsx"
import "../../styles/tokens.css"

export type MessageMeta = Pick<ChatResponse, "retrieval" | "security" | "model" | "workflow">

function initials(name: string): string {
	return name
		.split(/\s+/)
		.map((part) => part[0])
		.filter(Boolean)
		.slice(0, 2)
		.join("")
		.toUpperCase()
}

/**
 * Grounding state, in the shared system vocabulary.
 *
 * Confidence is only shown when the backend actually returned one - the UI
 * never manufactures a confidence level to look more certain than the
 * pipeline was.
 */
function groundingStamp(message: Message) {
	switch (message.grounding) {
		case "grounded":
			return (
				<StatusMark tone="ok">
					{message.confidence && message.confidence !== "none" ? `Grounded / ${message.confidence}` : "Grounded"}
				</StatusMark>
			)
		case "partial":
			return <StatusMark tone="warn">Partially grounded</StatusMark>
		case "insufficient_evidence":
			return <StatusMark tone="warn">Insufficient evidence</StatusMark>
		case "access_denied":
			return <StatusMark tone="deny">Access denied</StatusMark>
		default:
			return null
	}
}

/**
 * The retrieval trace, built strictly from what the response reported.
 * It exists to make authorization-before-retrieval legible, not to dump
 * backend internals into the UI.
 */
function traceSteps(message: Message, meta?: MessageMeta | null) {
	if (!meta?.retrieval) return []
	const { usedCount, candidateCount, deniedCount } = meta.retrieval
	const steps = [
		{ label: "Identity verified" },
		{ label: deniedCount > 0 ? `Authorized retrieval / ${deniedCount} withheld` : "Authorized retrieval" },
		{ label: `${usedCount} of ${candidateCount} sources`, active: usedCount > 0 },
	]
	steps.push({ label: message.grounding === "grounded" ? "Grounding verified" : "Grounding incomplete", active: message.grounding === "grounded" })
	return steps
}

/* Continuous typewriter on an animation-frame loop with a block caret. */
function Typewriter({ text, onTick, onDone }: { text: string; onTick?: () => void; onDone?: () => void }) {
	const [shown, setShown] = useState(0)
	const doneRef = useRef(false)

	useEffect(() => {
		const total = text.length
		if (total === 0) {
			onDone?.()
			return
		}
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			setShown(total)
			onDone?.()
			return
		}
		let raf = 0
		let last = performance.now()
		let acc = 0
		let current = 0
		const cps = Math.max(260, total / 2)
		const tick = (now: number) => {
			acc += ((now - last) / 1000) * cps
			last = now
			if (acc >= 1) {
				current = Math.min(total, current + Math.floor(acc))
				acc = 0
				setShown(current)
				onTick?.()
				if (current >= total) {
					if (!doneRef.current) {
						doneRef.current = true
						onDone?.()
					}
					return
				}
			}
			raf = requestAnimationFrame(tick)
		}
		raf = requestAnimationFrame(tick)
		return () => cancelAnimationFrame(raf)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	const finished = shown >= text.length
	return (
		<>
			{text.slice(0, shown)}
			{!finished ? <span className="wx-caret" aria-hidden="true" /> : null}
		</>
	)
}

/** A citation reads as a filed document: numbered tile, title, provenance. */
function CiteCard({
	index,
	number,
	title,
	section,
	department,
	version,
	classification,
}: {
	index: number
	number: number
	title: string
	section: string
	department: string
	version: string | number
	classification: string
}) {
	const magnet = useMagnet<HTMLDivElement>({ strength: 4 })
	const entrance = stagger(index, 0.07)
	return (
		<div
			ref={magnet.ref}
			onPointerMove={magnet.onPointerMove}
			onPointerLeave={magnet.onPointerLeave}
			className={`wx-cite mo-magnet ${entrance.className}`}
			style={entrance.style}
		>
			<div className="n">{number}</div>
			<div className="ti">
				{title}
				<span className="mt">{`${section || "General"} \u00b7 ${department} \u00b7 v${version}`}</span>
			</div>
			<Stamp kind={classification}>{classification}</Stamp>
			<i className="br" aria-hidden="true" />
		</div>
	)
}

/**
 * A single turn. Questions are bone slabs with a hard acid shadow; answers are
 * ink panels that carry their own evidence - grounding, retrieval counts,
 * citations, actions - in the same instrument language as the rest of the
 * console.
 */
export function ConsoleMessage({
	message,
	meta,
	stream = false,
	onStreamTick,
	onStreamDone,
}: {
	message: Message
	meta?: MessageMeta | null
	stream?: boolean
	onStreamTick?: () => void
	onStreamDone?: () => void
}) {
	const { me } = useSession()
	const [feedback, setFeedback] = useState(message.feedback)
	const [streamDone, setStreamDone] = useState(!stream)
	const isUser = message.role === "user"
	const assistantName = me?.tenant.settings.assistantName ?? "NOVA"
	const isSmalltalk = message.provider === "smalltalk"
	const streaming = stream && !isUser && !streamDone
	const showExtras = !stream || streamDone

	const send = async (value: "up" | "down") => {
		const next = feedback === value ? null : value
		setFeedback(next)
		try {
			await api.feedback(message.id, next)
		} catch {
			/* feedback is best-effort */
		}
	}

	return (
		<div
			className={`wx-msg mo-in${isUser ? " is-user" : ""}${message.grounding === "access_denied" ? " is-denied" : ""}`}
		>
			<div className={`wx-msg-who ${isUser ? "human" : "ai"}`}>
				<span className="tile" aria-hidden="true">
					{isUser ? initials(me?.user.name ?? "You") : "\u25c6"}
				</span>
				{isUser ? (me?.user.name ?? "You") : assistantName}
			</div>

			<div className="wx-bubble">
				{streaming ? (
					<Typewriter
						text={message.content}
						onTick={onStreamTick}
						onDone={() => {
							setStreamDone(true)
							onStreamDone?.()
						}}
					/>
				) : (
					message.content
				)}
			</div>

			{showExtras && !isUser && !isSmalltalk ? (
				<div className="wx-msg-meta mo-in">
					<TraceHeader steps={traceSteps(message, meta)} />
					{groundingStamp(message)}
					{meta?.retrieval ? (
						<span className="wx-chip" title="authorised chunks used / candidates considered">
							{`${meta.retrieval.strategy || meta.retrieval.provider || "vector"} \u00b7 ${meta.retrieval.usedCount}/${meta.retrieval.candidateCount} chunks`}
						</span>
					) : null}
					{meta?.retrieval && meta.retrieval.deniedCount > 0 ? (
						<span className="wx-chip magenta">{meta.retrieval.deniedCount} filtered by permissions</span>
					) : null}
					{meta?.model?.isFallback ? (
						<span className="wx-chip amber" title={meta.model.fallbackReason}>
							Fallback composer
						</span>
					) : null}
					{meta?.security?.documentInjectionFlags?.length ? (
						<span className="wx-chip amber">Document injection neutralised</span>
					) : null}
					{meta?.security?.userAttackFlags?.length ? (
						<span className="wx-chip amber">Prompt attack ignored</span>
					) : null}
					{message.latencyMs ? <span className="wx-chip cyan">{message.latencyMs} ms</span> : null}
				</div>
			) : null}

			{showExtras && message.action ? (
				/* Action receipt. SIMULATED is stated plainly: nothing outside NOVA
				   was modified when the action provider is the local one. */
				<div className="wx-receipt mo-in">
					<div className="wx-receipt-head">
						<TechnicalLabel accent>Action</TechnicalLabel>
						<StatusMark tone={message.action.simulated ? "sim" : "ok"}>
							{message.action.simulated ? "Simulated action" : "Live action"}
						</StatusMark>
					</div>
					<MetadataRow
						items={[
							{ key: "Reference", value: message.action.incident.code },
							{ key: "Machine", value: message.action.incident.machineId },
							{ key: "Severity", value: message.action.incident.severity },
							{ key: "Location", value: message.action.incident.location },
							{ key: "Observed", value: message.action.incident.observedAt },
							{ key: "Reporter", value: message.action.incident.reporter },
							{ key: "Status", value: message.action.incident.status },
						]}
					/>
				</div>
			) : null}

			{showExtras && message.citations.length > 0 ? (
				<div className="wx-sources">
					<EvidenceHeader count={message.citations.length} />
					{message.citations.map((citation, index) => (
						<CiteCard
							key={`${citation.versionId}-${citation.index}`}
							index={index}
							number={citation.index}
							title={citation.documentTitle}
							section={citation.section}
							department={citation.department}
							version={citation.version}
							classification={citation.classification}
						/>
					))}
				</div>
			) : null}

			{showExtras && !isUser && !isSmalltalk ? (
				<div className="wx-fb">
					<button
						type="button"
						className={`wx-btn small ${feedback === "up" ? "solid" : ""}`}
						onClick={() => void send("up")}
					>
						Useful
					</button>
					<button
						type="button"
						className={`wx-btn small ${feedback === "down" ? "danger" : ""}`}
						onClick={() => void send("down")}
					>
						Off target
					</button>
				</div>
			) : null}
		</div>
	)
}

export default ConsoleMessage
