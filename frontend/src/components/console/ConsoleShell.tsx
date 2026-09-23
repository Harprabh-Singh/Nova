import { useEffect, useRef, useState } from "react"
import { Link, useRouter } from "../../hooks/useRouter.tsx"
import { useSession } from "../../providers/SessionProvider.tsx"
import { useCharReveal } from "../../lib/anim.tsx"
import { useDepthDrift } from "../../lib/console-motion.tsx"
import { SystemBadge, TechnicalLabel } from "../shared/system.tsx"
import "../../styles/tokens.css"
import "../../anim.css"
import "../../styles/motion-extra.css"
import "../../styles/console.css"

type NavItem = { n: string; label: string; to: string; exact?: boolean }

const MAIN: NavItem[] = [
	{ n: "01", label: "Assistant", to: "/chat" },
	{ n: "02", label: "Knowledge library", to: "/knowledge", exact: true },
	{ n: "03", label: "Upload knowledge", to: "/knowledge/upload" },
	{ n: "04", label: "Settings", to: "/settings" },
]

const ADMIN: NavItem[] = [
	{ n: "05", label: "Dashboard", to: "/admin", exact: true },
	{ n: "06", label: "Documents", to: "/admin/knowledge" },
	{ n: "07", label: "Users", to: "/admin/users" },
	{ n: "08", label: "Roles", to: "/admin/roles" },
	{ n: "09", label: "Activity", to: "/admin/activity" },
	{ n: "10", label: "Configuration", to: "/admin/settings" },
]

export type ConsoleShellProps = {
	eyebrow?: string
	title?: string
	titleTail?: string
	lede?: string
	actions?: React.ReactNode
	children?: React.ReactNode
	/** Extra rail content (the assistant's conversation history) placed under the ask button. */
	railExtra?: React.ReactNode
	/** When true the page owns its own scroller and headline - used by the assistant. */
	bare?: boolean
}

/** A stat card: label, counted value, hint, and a scaleX edge that reads as a meter. */
export function Stat({
	label,
	value,
	hint,
	fill = 0.35,
	tone,
	delay = 0,
}: {
	label: string
	value: string | number
	hint?: string
	fill?: number
	tone?: "cyan" | "magenta" | "violet"
	delay?: number
}) {
	const clamped = Math.max(0, Math.min(1, Number.isFinite(fill) ? fill : 0))
	return (
		<div className={`wx-stat ${tone ?? ""}`} data-reveal style={{ transitionDelay: `${delay}s` }}>
			<div className="k">{label}</div>
			<div className="v">{value}</div>
			{hint ? <div className="h">{hint}</div> : null}
			<span className="edge" style={{ ["--fill" as string]: String(clamped) } as React.CSSProperties} />
		</div>
	)
}

/** A classification / status stamp, inked rather than filled. */
export function Stamp({ kind, children }: { kind?: string; children: React.ReactNode }) {
	return <span className={`wx-stamp ${kind ?? ""}`}>{children}</span>
}

/**
 * The frame every rail page sits in: fixed rail, instrument top bar, its own
 * scroller (so the window never jumps), and a char-revealed page headline.
 */
export function ConsoleShell({
	eyebrow,
	title,
	titleTail,
	lede,
	actions,
	children,
	railExtra,
	bare = false,
}: ConsoleShellProps) {
	const { me, health, signOut, authMode } = useSession()
	const { navigate, path } = useRouter()
	/**
	 * The rail is hidden by default and revealed on demand. Three independent
	 * reasons can hold it open; it retracts only when all three are false.
	 *
	 *   pinned  - explicit request (Menu control / touch). Escape or scrim closes.
	 *   hover   - pointer is inside the left edge strip or over the rail itself.
	 *   focus   - keyboard focus is somewhere inside the rail.
	 *
	 * Keeping them separate is what stops the pointer leaving the rail from
	 * yanking it away from a keyboard user, or an Escape press from wedging it
	 * shut while the cursor is still resting on it.
	 */
	const [railPinned, setRailPinned] = useState(false)
	const [railHover, setRailHover] = useState(false)
	const [railFocus, setRailFocus] = useState(false)
	const railVisible = railPinned || railHover || railFocus

	const scroller = useDepthDrift<HTMLDivElement>()
	const headline = useRef<HTMLSpanElement | null>(null)
	useCharReveal(headline, { delay: 0.06, stagger: 0.02 })

	/**
	 * A short grace period on leave. The trigger strip and the rail are two
	 * separate elements, so the pointer technically exits one before entering
	 * the other; closing instantly would make the rail flicker at that seam.
	 */
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const cancelClose = () => {
		if (closeTimer.current) {
			clearTimeout(closeTimer.current)
			closeTimer.current = null
		}
	}
	const holdOpen = () => {
		cancelClose()
		setRailHover(true)
	}
	const releaseOpen = () => {
		cancelClose()
		closeTimer.current = setTimeout(() => setRailHover(false), 180)
	}
	useEffect(() => cancelClose, [])

	// Escape closes only an explicitly pinned rail; hover/focus own themselves.
	useEffect(() => {
		if (!railPinned) return
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setRailPinned(false)
		}
		window.addEventListener("keydown", onKey)
		return () => window.removeEventListener("keydown", onKey)
	}, [railPinned])

	// Navigating retracts the rail and returns the reader to the top of the new
	// page. It does not reload, reset the composer, or drop conversation state.
	useEffect(() => {
		cancelClose()
		setRailPinned(false)
		setRailHover(false)
		if (scroller.current) scroller.current.scrollTop = 0
	}, [path])

	const initials = (me?.user.name ?? "?")
		.split(" ")
		.map((part) => part[0])
		.join("")
		.slice(0, 2)
		.toUpperCase()


	const renderNav = (items: NavItem[]) =>
		items.map((item) => (
			<Link to={item.to} activeWhenExact={item.exact} key={item.to}>
				<span className="n">{item.n}</span>
				<span>{item.label}</span>
			</Link>
		))

	return (
		<div className={`wx ${railVisible ? "rail-shown" : ""} ${railPinned ? "rail-pinned" : ""}`}>
			{/* The collapsed rail is itself the reveal trigger: it is always on
			    screen as a glyph strip, and hovering it expands it to full width. */}
			<aside
				className="wx-aside"
				aria-label="Console navigation"
				onMouseEnter={holdOpen}
				onMouseLeave={releaseOpen}
				onFocus={() => setRailFocus(true)}
				onBlur={(event) => {
					// Only collapse when focus actually leaves the rail subtree,
					// not when it moves between two controls inside it.
					if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setRailFocus(false)
				}}
			>
				<div className="wx-logo">
					{/* Collapsed, the wordmark reduces to its initial; the glyph and the
					    full wordmark are the same type, so nothing new is introduced. */}
					<span className="wx-logo-mark" aria-hidden="true">
						N
					</span>
					<span className="wx-logo-full">NOVA</span>
					<span className="wx-logo-sub">CONSOLE</span>
				</div>

				<button className="wx-ask" type="button" onClick={() => navigate("/chat")} title="Ask a question">
					<span className="wx-ask-label">Ask a question</span>
					<span className="wx-ask-glyph" aria-hidden="true">
						&rarr;
					</span>
				</button>

				{railExtra}

				<nav className="wx-nav">
					<div className="wx-label">Workspace</div>
					{renderNav(MAIN)}

					{me?.scope.isAdmin ? (
						<>
							<div className="sec">Administration</div>
							{renderNav(ADMIN)}
						</>
					) : null}

					<div className="sec">Platform</div>
					<Link to="/onboarding">
						<span className="n">&mdash;</span>
						<span>Create a workspace</span>
					</Link>
				</nav>

				<div className="wx-id">
					{/* Collapsed, identity reduces to the initials already shown in the
					    top bar chip - same vocabulary, no new element invented. */}
					<div className="wx-id-mark" aria-hidden="true">
						{initials}
					</div>
					<div className="k">Signed in as</div>
					<div className="nm">{me?.user.name ?? "\u2014"}</div>
					<div className="mt">
						{me?.role?.name}
						{me?.user.department ? ` \u00b7 ${me.user.department}` : ""}
					</div>
					{/* Persona switching exists only in local demo authentication. */}
					{authMode === "demo" ? (
						<button type="button" onClick={() => navigate("/login")}>
							Switch persona
						</button>
					) : null}
					<button
						className="wx-signout"
						type="button"
						onClick={() => {
							signOut()
							navigate("/login")
						}}
					>
						Sign out
					</button>
				</div>
			</aside>

			<button className="wx-scrim" type="button" aria-label="Close navigation" onClick={() => setRailPinned(false)} />

			<main className="wx-main">
				<header className="wx-top">
					<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
						<button
							className="wx-burger"
							type="button"
							aria-expanded={railVisible}
							aria-label={railPinned ? "Close navigation" : "Open navigation"}
							onClick={() => setRailPinned(!railPinned)}
						>
							Menu
						</button>
						<strong>{me?.tenant.name ?? "NOVA"}</strong>
					</div>
					<div className="wx-top-right">
						{/* System state, in the shared vocabulary. The deployment badge is
						    driven by verified provider health, never by configuration. */}
						{me?.tenant.industry ? <TechnicalLabel>{me.tenant.industry}</TechnicalLabel> : null}
						<span className="wx-chip">
							{initials} &middot; {me?.user.roleKey}
						</span>
						<SystemBadge isFullyLocal={health?.isFullyLocal} azureConfigured={health?.azureConfigured} />
					</div>
				</header>

				{bare ? (
					<div className="wx-flow">{children}</div>
				) : (
				<div className="wx-scroll" ref={scroller}>
					<div className="wx-body">
						<div className="wx-head">
							<div className="wx-head-row">
								<div>
									<div className="wx-kicker">{eyebrow}</div>
									<h1>
										<span ref={headline}>{title}</span>{" "}
										{titleTail ? <span className="out">{titleTail}</span> : null}
									</h1>
								</div>
								{actions ? <div className="wx-head-actions">{actions}</div> : null}
							</div>
							{lede ? <p className="wx-lede">{lede}</p> : null}
						</div>
						{children}
					</div>
				</div>
				)}
			</main>
		</div>
	)
}

/** The same frame, but it refuses to render admin content to a non-admin role. */
export function AdminConsole(props: ConsoleShellProps) {
	const { me } = useSession()

	if (me && !me.scope.isAdmin) {
		return (
			<ConsoleShell
				eyebrow="05 / Administration"
				title="Access"
				titleTail="denied."
				lede="ACCESS DENIED - your current role does not have permission to access this information."
			>
				<div className="wx-alert">Switch to an administrator persona to continue</div>
			</ConsoleShell>
		)
	}

	return <ConsoleShell {...props} />
}

export default ConsoleShell
