import { useEffect, useRef, useState } from "react"
import { useRouter } from "../../hooks/useRouter.tsx"
import { useSession } from "../../providers/SessionProvider.tsx"
import type { Persona } from "../../types/index.ts"
import { AccessEnvironment } from "./AccessEnvironment.tsx"
import { AccessBrand, AccessStatus as AccessStatusBadge } from "./AccessBrand.tsx"
import { AccessEditorialCopy } from "./AccessEditorialCopy.tsx"
import { AccessTerminal } from "./AccessTerminal.tsx"
import { EntraTerminal } from "./EntraTerminal.tsx"
import { AccessFooter } from "./AccessFooter.tsx"
import type { AccessStatus } from "./AccessActions.tsx"
import "../../styles/access.css"

/* ============================================================================
   NOVA — THE ACCESS CHAMBER  (/login)

   Not a login screen: the gate into the knowledge system. You choose a
   workspace and an identity, and the page's whole argument is that this
   choice happens first, because retrieval depends on it.

   Composition: the statement is printed on the left wall, the terminal is
   recessed into the right wall, and the daylit atrium opening runs between
   them. The room — not a column gap — does the separating.

   Everything on screen is driven by real application state: tenants from
   /api/tenants, identities from /api/personas, the runtime badge from the
   backend's own health report. The frontend only starts a demo session as
   the chosen persona; the backend still resolves tenant, role and
   permissions, and retrieval enforces them.
   ========================================================================== */

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function AccessPage() {
	const {
		tenants,
		personas,
		personaNotice,
		signIn,
		loadPersonas,
		health,
		ready,
		authMode,
		authPhase,
		authError,
		entraAccount,
		signInWithMicrosoft,
		signOut,
		me,
	} = useSession()
	const { navigate } = useRouter()

	const [tenantId, setTenantId] = useState("")
	const [selected, setSelected] = useState<Persona | null>(null)
	const [status, setStatus] = useState<AccessStatus>("idle")
	const [error, setError] = useState<string | null>(null)
	const root = useRef<HTMLElement>(null)

	/* Resolve the first workspace once tenants arrive, and load its register. */
	useEffect(() => {
		if (!tenantId && tenants[0]) {
			setTenantId(tenants[0].id)
			void loadPersonas(tenants[0].id)
		}
	}, [tenants, tenantId, loadPersonas])

	/* Default to the first identity so the console is never empty, but the
	   register makes it obvious the choice is yours to change. */
	useEffect(() => {
		if (personas.length === 0) {
			setSelected(null)
			return
		}
		setSelected((current) => {
			if (current && personas.some((persona) => persona.id === current.id)) return current
			return personas[0]
		})
	}, [personas])

	/* A few pixels of room parallax. The typography never moves. */
	useEffect(() => {
		const el = root.current
		if (!el) return
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
		if (window.matchMedia("(max-width: 900px)").matches) return

		let raf = 0
		let x = 0
		let y = 0
		const apply = () => {
			raf = 0
			el.style.setProperty("--par-x", `${x.toFixed(2)}px`)
			el.style.setProperty("--par-y", `${y.toFixed(2)}px`)
		}
		const onMove = (event: PointerEvent) => {
			x = (event.clientX / window.innerWidth - 0.5) * -5
			y = (event.clientY / window.innerHeight - 0.5) * -3
			if (!raf) raf = requestAnimationFrame(apply)
		}
		window.addEventListener("pointermove", onMove, { passive: true })
		return () => {
			window.removeEventListener("pointermove", onMove)
			if (raf) cancelAnimationFrame(raf)
		}
	}, [])

	// The badge reports only what the backend verified — never the mere
	// presence of configuration.
	const mode = !health
		? "Connecting"
		: authMode === "entra"
			? "Microsoft Entra ID"
			: health.isFullyLocal || !health.azureConfigured
				? "Local demo mode"
				: "Hosted demo"

	/* Entra mode: once NOVA has authorized the identity, enter the console. */
	useEffect(() => {
		if (authMode === "entra" && me) navigate("/chat")
	}, [authMode, me, navigate])

	const onTenantChange = (nextId: string) => {
		setTenantId(nextId)
		setSelected(null)
		setError(null)
		setStatus("idle")
		void loadPersonas(nextId)
	}

	const onContinue = async () => {
		if (!selected || !tenantId) return
		setError(null)
		setStatus("resolving")
		try {
			// The backend issues the session; only then is the identity resolved.
			await signIn({ tenantId, userId: selected.id })
			setStatus("resolved")
			await wait(260)
			setStatus("entering")
			await wait(300)
			navigate("/chat")
		} catch (caught) {
			setStatus("error")
			setError(caught instanceof Error ? caught.message : "Unable to initialize the demo persona.")
		}
	}

	const leaving = status === "entering"

	return (
		<main className={`access-page${leaving ? " is-leaving" : ""}`} ref={root} aria-labelledby="access-title">
			<AccessEnvironment />

			<AccessBrand />
			<AccessStatusBadge mode={mode} />

			{/* Editorial marks painted onto the architecture itself. */}
			<span className="access-wallmark is-left" aria-hidden="true">
				Identity
				<br />
				first.
				<br />
				<br />
				Knowledge
				<br />
				follows
				<br />
				permission.
			</span>
			<span className="access-wallmark is-right" aria-hidden="true">
				Built for
				<br />
				people
				<br />
				who turn
				<br />
				knowledge
				<br />
				into progress.
			</span>

			<div className="access-stage">
				{/* On mobile the masthead rejoins the flow above the statement. */}
				<div className="access-mobile-head" aria-hidden="true">
					<AccessBrand />
					<AccessStatusBadge mode={mode} />
				</div>

				<AccessEditorialCopy />

				<div className="access-console">
					{authMode === "entra" ? (
						<EntraTerminal
							phase={authPhase}
							account={entraAccount}
							error={authError}
							onSignIn={() => void signInWithMicrosoft()}
							onSignOut={() => signOut()}
						/>
					) : (
					<AccessTerminal
						tenants={tenants}
						tenantId={tenantId}
						personas={personas}
						selected={selected}
						status={status}
						loading={!ready}
						error={error}
						notice={personaNotice}
						onTenantChange={onTenantChange}
						onSelect={(persona) => {
							setSelected(persona)
							setError(null)
							setStatus("idle")
						}}
						onContinue={() => void onContinue()}
						onOnboard={() => navigate("/onboarding")}
					/>
					)}
				</div>
			</div>

			<AccessFooter />
		</main>
	)
}
// hist: 2026-09-24T07:02:53+05:30
