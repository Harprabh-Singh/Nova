import type { Persona } from "../../types/index.ts"

/* ============================================================================
   The two ways in.

   The primary button's label tracks the real access sequence — it only says
   "Identity resolved" once the backend has actually issued a session, so the
   status text reports state rather than performing it.
   ========================================================================== */

export type AccessStatus = "idle" | "resolving" | "resolved" | "entering" | "error"

const LABELS: Record<AccessStatus, string> = {
	idle: "Continue as persona",
	resolving: "Resolving identity",
	resolved: "Identity resolved",
	entering: "Accessing knowledge",
	error: "Retry access",
}

export function AccessActions({
	persona,
	status,
	disabled,
	onContinue,
	onOnboard,
}: {
	persona: Persona | null
	status: AccessStatus
	disabled: boolean
	onContinue: () => void
	onOnboard: () => void
}) {
	const busy = status === "resolving" || status === "resolved" || status === "entering"

	return (
		<div className="access-actions">
			<button
				type="button"
				className={`access-btn primary is-${status}`}
				disabled={disabled || busy || !persona}
				onClick={onContinue}
			>
				<span>{LABELS[status]}</span>
				<span className="arrow" aria-hidden="true">
					→
				</span>
			</button>

			<button type="button" className="access-btn secondary" disabled={busy} onClick={onOnboard}>
				Onboard a company instead
			</button>
		</div>
	)
}
