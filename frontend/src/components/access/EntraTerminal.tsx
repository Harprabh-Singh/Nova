import type { AuthPhase } from "../../providers/SessionProvider.tsx"
import type { EntraAccount } from "../../auth/entraClient.ts"

/* ============================================================================
   NOVA://ACCESS — Microsoft Entra ID.

   The same access unit as the demo terminal, with the persona register
   removed: in production you do not choose who you are. Microsoft Entra
   authenticates the human; NOVA (Neon) then resolves the workspace, role,
   department and classification clearance. None of those are selectable
   here, and none of them are sent by the browser.
   ========================================================================== */

export function EntraTerminal({
	phase,
	account,
	error,
	onSignIn,
	onSignOut,
}: {
	phase: AuthPhase
	account: EntraAccount | null
	error: string | null
	onSignIn: () => void
	onSignOut: () => void
}) {
	const busy = phase === "loading" || phase === "signing-in"
	const label = phase === "signing-in" ? "Opening Microsoft sign-in" : phase === "loading" ? "Checking session" : "Sign in with Microsoft"

	return (
		<section className="access-terminal" aria-label="NOVA access">
			<header className="access-terminal-header">
				<span className="name">
					NOVA://<em>ACCESS</em>
				</span>
				<span className="mode">Microsoft Entra ID</span>
			</header>

			<div className="identity-summary">
				<div className="k">Identity provider</div>
				<div className="nm">Microsoft Entra ID</div>
				<div className="mt">
					Authorization code with PKCE · single tenant
					<br />
					Workspace, role, department and clearance are resolved by NOVA after sign-in.
				</div>
			</div>

			{account ? (
				<div className="identity-summary">
					<div className="k">Signed in as</div>
					<div className="nm">{account.name || account.username}</div>
					<div className="mt">{account.username}</div>
				</div>
			) : null}

			{error ? (
				<div className="access-alert" role="alert">
					<b>Access failed</b>
					{error}
				</div>
			) : null}

			<div className="access-actions">
				<button type="button" className={`access-btn primary is-${phase}`} disabled={busy} onClick={onSignIn}>
					<span>{label}</span>
					<span className="arrow" aria-hidden="true">
						→
					</span>
				</button>
				{account ? (
					<button type="button" className="access-btn secondary" disabled={busy} onClick={onSignOut}>
						Sign out of Microsoft
					</button>
				) : null}
			</div>

			<footer className="access-terminal-foot">
				Microsoft Entra ID · production authentication
				<br />
				NOVA authorization is resolved server-side.
			</footer>
		</section>
	)
}
