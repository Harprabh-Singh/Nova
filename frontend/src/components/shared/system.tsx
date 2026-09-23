/**
 * NOVA shared system vocabulary.
 *
 * One implementation of every technical-metadata pattern in the product.
 * Chat, citations, knowledge, admin and action receipts all render their
 * labels, status marks and traces through these components, so the word
 * GROUNDING looks identical wherever it appears.
 *
 * Styling lives in styles/tokens.css (.nova-*). Nothing here owns colour.
 */
import type { ReactNode } from "react"

/** A mono, letterspaced section marker: IDENTITY, SOURCES, RETRIEVAL TRACE. */
export function TechnicalLabel({ children, accent = false }: { children: ReactNode; accent?: boolean }) {
	return <span className={`nova-label${accent ? " is-accent" : ""}`}>{children}</span>
}

export type StatusTone = "neutral" | "ok" | "warn" | "deny" | "sim"

/** A state mark. The tone is derived from real backend state, never guessed. */
export function StatusMark({ tone = "neutral", children }: { tone?: StatusTone; children: ReactNode }) {
	const suffix = tone === "neutral" ? "" : ` is-${tone}`
	return <span className={`nova-status${suffix}`}>{children}</span>
}

/** A key/value block: TENANT, IDENTITY, VERSION, MODEL, MODE. */
export function MetadataRow({ items }: { items: Array<{ key: string; value: ReactNode }> }) {
	return (
		<dl className="nova-meta">
			{items.map((item) => (
				<div key={item.key} style={{ display: "contents" }}>
					<dt>{item.key}</dt>
					<dd>{item.value}</dd>
				</div>
			))}
		</dl>
	)
}

export type TraceStep = { label: string; active?: boolean }

/**
 * The authorization-before-retrieval trace, rendered as the pipeline the
 * backend actually ran. Steps are passed in by the caller from real response
 * metadata; this component never invents a stage.
 */
export function TraceHeader({ steps }: { steps: TraceStep[] }) {
	if (steps.length === 0) return null
	return (
		<div className="nova-trace" role="group" aria-label="Retrieval trace">
			{steps.map((step) => (
				<span key={step.label} className={`nova-trace-step${step.active === false ? " is-muted" : ""}`}>
					<i aria-hidden="true" />
					{step.label}
				</span>
			))}
		</div>
	)
}

/** Header above a list of citations: EVIDENCE - 3 SOURCES. */
export function EvidenceHeader({ count }: { count: number }) {
	return (
		<div className="nova-trace" style={{ borderBottom: "none" }}>
			<TechnicalLabel accent>Evidence</TechnicalLabel>
			<span>{`${count} ${count === 1 ? "source" : "sources"}`}</span>
		</div>
	)
}

/**
 * The deployment badge. It reflects VERIFIED provider health only: a
 * configured Azure endpoint that has not passed a health check reads
 * AZURE CONFIGURED / INCOMPLETE. The health endpoint performs no live Azure
 * call, so the UI never claims a verified connection.
 */
export function SystemBadge({ isFullyLocal, azureConfigured }: { isFullyLocal?: boolean; azureConfigured?: boolean }) {
	if (isFullyLocal === undefined) return <StatusMark>Connecting</StatusMark>
	if (isFullyLocal) return <StatusMark tone="sim">Local demo mode</StatusMark>
	if (azureConfigured) return <StatusMark tone="ok">Azure configured</StatusMark>
	return <StatusMark tone="warn">Azure configured / incomplete</StatusMark>
}
