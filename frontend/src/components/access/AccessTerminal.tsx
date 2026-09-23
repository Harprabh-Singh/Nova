import type { Persona } from "../../types/index.ts"
import { WorkspaceSelector } from "./WorkspaceSelector.tsx"
import { PersonaRegister } from "./PersonaRegister.tsx"
import { IdentitySummary } from "./IdentitySummary.tsx"
import { AccessActions, type AccessStatus } from "./AccessActions.tsx"

/* ============================================================================
   NOVA://ACCESS — the identity terminal.

   A dark metal-and-glass access unit installed into the concrete wall, not
   a dashboard floating on a page: machined frame, lime edge where the light
   catches it, hard shoulder shadow, square corners.

   Order follows the act of entering: which building, then who, then the
   resolved record, then the door.

   The frontend only chooses which demo session to start. The backend still
   resolves tenant, user, role and permissions, and retrieval enforces them
   before any knowledge reaches the model.
   ========================================================================== */

export function AccessTerminal({
	tenants,
	tenantId,
	personas,
	selected,
	status,
	loading,
	error,
	notice,
	onTenantChange,
	onSelect,
	onContinue,
	onOnboard,
}: {
	tenants: Array<{ id: string; name: string; industry: string }>
	tenantId: string
	personas: Persona[]
	selected: Persona | null
	status: AccessStatus
	loading: boolean
	error: string | null
	notice: string
	onTenantChange: (tenantId: string) => void
	onSelect: (persona: Persona) => void
	onContinue: () => void
	onOnboard: () => void
}) {
	const busy = status === "resolving" || status === "resolved" || status === "entering"

	/* The backend sends its own demo-persona caveat. The terminal already
	   carries that statement in its footer, so only surface the notice when it
	   says something the footer does not — the disclaimer appears exactly once. */
	const noticeIsDisclaimer = /demo\s+persona|identity\s+provider/i.test(notice)
	const extraNotice = notice && !noticeIsDisclaimer ? notice : ""

	return (
		<section className="access-terminal" aria-label="NOVA access">
			<header className="access-terminal-header">
				<span className="name">
					NOVA://<em>ACCESS</em>
				</span>
				<span className="mode">Demo authentication</span>
			</header>

			<WorkspaceSelector tenants={tenants} value={tenantId} disabled={busy} onChange={onTenantChange} />

			<PersonaRegister
				personas={personas}
				selectedId={selected?.id ?? null}
				disabled={busy}
				loading={loading}
				onSelect={onSelect}
			/>

			{selected ? <IdentitySummary persona={selected} /> : null}

			{error ? (
				<div className="access-alert" role="alert">
					<b>Access failed</b>
					{error}
				</div>
			) : null}

			<AccessActions
				persona={selected}
				status={status}
				disabled={loading}
				onContinue={onContinue}
				onOnboard={onOnboard}
			/>

			{extraNotice ? <p className="access-notice">{extraNotice}</p> : null}

			{/* Stated exactly once, as the terminal footer. */}
			<footer className="access-terminal-foot">
				Demo persona · local demo authentication
				<br />
				Not a real identity provider.
			</footer>
		</section>
	)
}
