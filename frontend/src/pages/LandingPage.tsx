import { useEffect, useRef, useState } from "react"
import { useRouter } from "../hooks/useRouter.tsx"
import { useSession } from "../providers/SessionProvider.tsx"
import { useSmoothScroll } from "../lib/anim.tsx"
import "../landing.css"
import { NovaProofScene } from "../components/proof/NovaProofScene.tsx"
import { HowItWorksSection } from "../components/how-it-works/HowItWorksSection.tsx"
import { GuaranteesSection } from "../components/guarantees/GuaranteesSection.tsx"
import { NumbersSection } from "../components/numbers/NumbersSection.tsx"
import { FinalCtaSection } from "../components/final-cta/FinalCtaSection.tsx"
import type { HeroRuntimeMode } from "../components/hero/HeroStatus.tsx"

/* ============================================================================
   NOVA — home page
   Dark editorial layout over a scroll-scrubbed 30fps hero. All motion comes
   from the shared toolkit in lib/anim.tsx: scrubbed scroll progress, split-text
   reveals, scroll-lit words, pinned snap carousel, 3D tilt, spring hovers.
   ========================================================================== */

/* ------------------------------------------------------------------- data */

const TICKER = [
	""
]

const MANIFESTO =
	"A confident sentence is not an answer. NOVA only speaks from documents it was allowed to open, and it shows you exactly which ones. Change a policy on Monday and every answer changes on Monday."

const DEMO_QUESTION = "Can I approve an ₹80,000 equipment purchase?"
const DEMO_ANSWER = "Yes — up to ₹1,00,000 sits inside your approval authority per the Procurement Policy."
const DEMO_CITATION = "Procurement Policy · v2026.2 · §4.2"

function DemoChat() {
	const [phase, setPhase] = useState(0)
	const [qChars, setQChars] = useState(0)
	const [aChars, setAChars] = useState(0)

	useEffect(() => {
		let timer: ReturnType<typeof setTimeout>
		let interval: ReturnType<typeof setInterval>
		let cancelled = false

		const playAnswer = () => {
			setPhase(2)
			setAChars(0)
			interval = setInterval(() => {
				setAChars((c) => {
					if (c >= DEMO_ANSWER.length) {
						clearInterval(interval)
						setPhase(3)
						timer = setTimeout(() => !cancelled && run(), 5400)
						return c
					}
					return c + 2
				})
			}, 40)
		}

		const run = () => {
			setPhase(0)
			setQChars(0)
			setAChars(0)
			interval = setInterval(() => {
				setQChars((c) => {
					if (c >= DEMO_QUESTION.length) {
						clearInterval(interval)
						setPhase(1)
						timer = setTimeout(() => !cancelled && playAnswer(), 1400)
						return c
					}
					return c + 1
				})
			}, 52)
		}

		run()
		return () => {
			cancelled = true
			clearTimeout(timer)
			clearInterval(interval)
		}
	}, [])

	const answer = phase === 2 ? DEMO_ANSWER.slice(0, aChars) : phase >= 3 ? DEMO_ANSWER : ""

	return (
		<div className="lpx-demo">
			<div className="lpx-demo-head">
				<span className="dots">
					<i />
					<i />
					<i />
				</span>
				nova://assistant
				<span className="live">
					<b /> live
				</span>
			</div>
			<div className="lpx-demo-body">
				<div className="lpx-msg user">
					{phase === 0 ? DEMO_QUESTION.slice(0, qChars) : DEMO_QUESTION}
					{phase === 0 ? <span className="lpx-caret" /> : null}
				</div>
				{phase === 1 ? (
					<div className="lpx-msg ai">
						<span className="lpx-think">
							<i />
							<i />
							<i />
						</span>{" "}
						retrieving authorized chunks…
					</div>
				) : null}
				{phase >= 2 ? (
					<div className="lpx-msg ai">
						{answer}
						{phase === 2 ? <span className="lpx-caret" /> : null}
						{phase === 3 ? (
							<div className="lpx-cite">
								<b>1</b> {DEMO_CITATION}
							</div>
						) : null}
					</div>
				) : null}
			</div>
		</div>
	)
}

/* ------------------------------------------------------------------ stats */


/* ------------------------------------------------------------------- hero */

/* ------------------------------------------------------------------- page */

export function LandingPage() {
	const { navigate } = useRouter()
	const { me, health, tenants } = useSession()
	/* Mounts the inertial wheel scroller for the page; anchor clicks ease
	   themselves in `go()` below. */
	useSmoothScroll()

	// Never claim a hosted/Azure connection unless the backend verified it.
	const runtimeMode: HeroRuntimeMode = !health
		? "unknown"
		: health.isFullyLocal || !health.azureConfigured
			? "local"
			: "hosted"
	// Tenant metadata comes from tenant configuration, not business logic.
	const tenantName = (me?.tenant?.name ?? tenants[0]?.name ?? "Demo tenant").toUpperCase()

	const navRef = useRef<HTMLElement>(null)
	const anchorRaf = useRef(0)
	const [mounted, setMounted] = useState(false)

	useEffect(() => {
		const raf = requestAnimationFrame(() => setMounted(true))
		return () => cancelAnimationFrame(raf)
	}, [])

	/* Progress bar + nav state are written straight to the DOM in one rAF,
	   so scrolling the page never re-renders the React tree. */
	useEffect(() => {
		let raf = 0
		let queued = false
		let lastY = window.scrollY

		const frame = () => {
			raf = 0
			queued = false
			const y = window.scrollY
			const nav = navRef.current
			if (nav) {
				nav.classList.toggle("solid", y > 40)
				if (y > lastY + 2 && y > 520) nav.classList.add("tucked")
				else if (y < lastY - 2 || y <= 520) nav.classList.remove("tucked")
			}
			lastY = y
		}

		const onScroll = () => {
			if (queued) return
			queued = true
			raf = requestAnimationFrame(frame)
		}

		frame()
		window.addEventListener("scroll", onScroll, { passive: true })
		return () => {
			window.removeEventListener("scroll", onScroll)
			if (raf) cancelAnimationFrame(raf)
		}
	}, [])

	/* Anchor navigation. The inertial wheel scroller stands down on touch and
	   reduced-motion, so nav clicks own their easing here instead of depending
	   on it. The target is offset by the fixed nav so headings are not hidden
	   underneath it on arrival. */
	const go = (id: string) => {
		const el = document.getElementById(id)
		if (!el) return

		const navHeight = navRef.current?.offsetHeight ?? 0
		const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
		const to = Math.min(max, Math.max(0, el.getBoundingClientRect().top + window.scrollY - navHeight - 8))

		if (anchorRaf.current) cancelAnimationFrame(anchorRaf.current)
		anchorRaf.current = 0

		const from = window.scrollY
		const span = to - from
		if (Math.abs(span) < 2) return

		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			window.scrollTo(0, to)
			return
		}

		/* Longer journeys get a little more time, but never a sluggish one. */
		const duration = Math.min(1150, Math.max(520, Math.abs(span) * 0.38))
		const start = performance.now()
		/* easeInOutCubic: settles without overshooting. */
		const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

		const step = (now: number) => {
			const t = Math.min(1, (now - start) / duration)
			window.scrollTo(0, from + span * ease(t))
			anchorRaf.current = t < 1 ? requestAnimationFrame(step) : 0
		}
		anchorRaf.current = requestAnimationFrame(step)
	}

	const enter = () => navigate(me ? "/chat" : "/login")

	return (
		<div className="lpx">
			<div className="lpx-grain" aria-hidden="true" />

			<nav className="lpx-nav" ref={navRef}>
				<span className="lpx-logo">
					<span className="mark" /> NO<span className="b">V</span>
					<span className="c">A</span>
				</span>
				<div className="lpx-nav-links">
					<button onClick={() => go("difference")}>
						Difference <span className="an-underline" />
					</button>
					<button onClick={() => go("how")}>
						How it works <span className="an-underline" />
					</button>
					<button onClick={() => go("capabilities")}>
						Capabilities <span className="an-underline" />
					</button>
					<button onClick={() => navigate("/onboarding")}>
						Onboard <span className="an-underline" />
					</button>
				</div>
				<button className="lpx-btn" onClick={enter}>
					<span className="sheen" />
					{me ? "Assistant" : "Enter demo"} <span className="arrow">→</span>
				</button>
			</nav>

			{/* ---------- ONE SCENE: THE KNOWLEDGE CHAMBER -> THE PROOF CHAMBER ----------
			    The hero is no longer a section that scrolls away above a second
			    section that renders lookalike artifacts. It is a LAYER inside one
			    pinned stage, and the document artifacts are owned by the scene,
			    so a single set of elements exists from the first frame to the
			    last. Nothing is handed over, because nothing is duplicated. */}
			<div id="difference" />
			<NovaProofScene
				mode={runtimeMode}
				tenantName={tenantName}
				ctaLabel={me ? "The Assistant" : "The Demo"}
				onEnter={enter}
				onOnboard={() => navigate("/onboarding")}
				onScrollNext={() => go("how")}
			/>

			{/* ---------- HORIZONTAL STORY ---------- */}
			<div className="lpx-ticker" aria-hidden="true">
				<div className="track">
					{[...TICKER, ...TICKER, ...TICKER, ...TICKER].map((item, i) => (
						<span key={i}>{item}</span>
					))}
				</div>
			</div>
			<div id="how" />
			<HowItWorksSection />

			{/* ---------- THE GUARANTEE GRID ---------- */}
			<GuaranteesSection onEnter={enter} />

			{/* ---------- THE EVIDENCE WALL ---------- */}
			<NumbersSection />

			{/* ---------- THE THRESHOLD ---------- */}
			<FinalCtaSection
				mode={runtimeMode}
				onEnter={enter}
				onOnboard={() => navigate("/onboarding")}
			/>
		</div>
	)
}
// hist: 2026-09-23T23:46:09+05:30
