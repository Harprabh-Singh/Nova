import type { ReactNode } from "react"
import type { HealthResponse } from "../types/index.ts"

export function ModeBadge({ health }: { health: HealthResponse | null }) {
	if (!health) return <span className="badge">checking mode…</span>
	const badge = health.modeBadge
	const tone = badge === "LOCAL DEMO MODE" ? "local" : badge === "AZURE CONFIGURED" ? "azure" : "unverified"
	return (
		<span className={`badge ${tone}`} title={`app mode: ${health.appMode}`}>
			{badge}
		</span>
	)
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
	return (
		<div className="card stat">
			<div className="k">{label}</div>
			<div className="v">{value}</div>
			{hint ? <div className="muted" style={{ fontSize: 12 }}>{hint}</div> : null}
		</div>
	)
}

export function Alert({ kind = "error", children }: { kind?: "error" | "info" | "success"; children: ReactNode }) {
	return <div className={`alert ${kind === "error" ? "" : kind}`}>{children}</div>
}

export function Spinner({ label }: { label?: string }) {
	return (
		<div className="row muted">
			<span className="typing">
				<span />
				<span />
				<span />
			</span>
			{label ?? "Loading…"}
		</div>
	)
}

export function PageHead({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
	return (
		<div className="page-head row spread" style={{ alignItems: "flex-start" }}>
			<div>
				<h1>{title}</h1>
				{subtitle ? <p>{subtitle}</p> : null}
			</div>
			{actions ? <div className="row">{actions}</div> : null}
		</div>
	)
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="field">
			<label>{label}</label>
			{children}
		</div>
	)
}

export function ClassificationBadge({ value }: { value: string }) {
	const tone = value === "restricted" || value === "confidential" ? "deny" : value === "public" ? "ok" : ""
	return <span className={`badge ${tone}`}>{value}</span>
}
