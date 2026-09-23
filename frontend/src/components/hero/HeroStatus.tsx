/**
 * Runtime mode badge, top-right.
 *
 * The label is derived from state the backend has actually reported — never
 * from the mere presence of environment variables. Anything short of a
 * verified remote deployment reads as the local demo runtime.
 */
export type HeroRuntimeMode = "local" | "hosted" | "unknown"

const LABELS: Record<HeroRuntimeMode, string> = {
	local: "Local demo mode",
	hosted: "Hosted demo",
	unknown: "Connecting",
}

export function HeroStatus({ mode }: { mode: HeroRuntimeMode }) {
	return (
		<div className={`nvh-status is-${mode}`}>
			<span className="nvh-status-dot" aria-hidden="true" />
			<span>{LABELS[mode]}</span>
		</div>
	)
}
