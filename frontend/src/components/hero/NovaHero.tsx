import { useEffect, useRef, useState } from "react"
import { DemoPortal, HeroOnboardLink, HeroScrollCue } from "./DemoPortal.tsx"
import { HeroAnnotations } from "./HeroAnnotations.tsx"
import { HeroBottomStrip } from "./HeroBottomStrip.tsx"
import { HeroBrand } from "./HeroBrand.tsx"
import { HeroEnvironment } from "./HeroEnvironment.tsx"
import { HeroStatus, type HeroRuntimeMode } from "./HeroStatus.tsx"
import { HeroTitle } from "./HeroTitle.tsx"
import { KnowledgeCore } from "./KnowledgeCore.tsx"
import { OrbitSystem } from "./OrbitSystem.tsx"
import "../../styles/hero.css"

type Props = {
	mode: HeroRuntimeMode
	tenantName: string
	ctaLabel: string
	onEnter: () => void
	onOnboard: () => void
	onScrollNext: () => void
	/**
	 * The hero is mounted as a layer inside the continuous scene rather than as
	 * its own scrolling section. Two things change:
	 *  - `pinned` stops the hero measuring its own scroll; the scene owns the
	 *    timeline and writes --nvh-out directly, so the hero recedes in step
	 *    with everything else instead of on a second, conflicting clock.
	 *  - (the floating document layer has been removed from the composition; the scene
	 *    renders those artifacts once, for the whole journey. There is no second
	 *    copy to hand off to.
	 */
	pinned?: boolean
}

/**
 * NOVA hero -- "The Knowledge Chamber".
 *
 * Composition root only. Every layer is a component; the single raster asset is
 * the architectural photograph inside <HeroEnvironment />. Pointer and scroll
 * parallax are published as CSS custom properties from one rAF loop, so the
 * scene animates without a React render per frame.
 */
export function NovaHero({
	mode,
	tenantName,
	ctaLabel,
	onEnter,
	onOnboard,
	onScrollNext,
	pinned = false,
}: Props) {
	const rootRef = useRef<HTMLElement>(null)
	const [mounted, setMounted] = useState(false)

	/* Start the load sequence one frame after paint. */
	useEffect(() => {
		const raf = requestAnimationFrame(() => setMounted(true))
		return () => cancelAnimationFrame(raf)
	}, [])

	/* Pointer parallax. Per-layer depth is applied in CSS from --nvh-mx/--nvh-my. */
	useEffect(() => {
		const root = rootRef.current
		if (!root) return
		if (window.matchMedia("(hover: none)").matches) return
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return

		let raf = 0
		let targetX = 0
		let targetY = 0
		let x = 0
		let y = 0

		const tick = () => {
			x += (targetX - x) * 0.07
			y += (targetY - y) * 0.07
			root.style.setProperty("--nvh-mx", x.toFixed(4))
			root.style.setProperty("--nvh-my", y.toFixed(4))
			const moving = Math.abs(targetX - x) > 0.001 || Math.abs(targetY - y) > 0.001
			raf = moving ? requestAnimationFrame(tick) : 0
		}
		const wake = () => {
			if (!raf) raf = requestAnimationFrame(tick)
		}
		const onMove = (event: PointerEvent) => {
			targetX = (event.clientX / window.innerWidth) * 2 - 1
			targetY = (event.clientY / window.innerHeight) * 2 - 1
			wake()
		}
		const onLeave = () => {
			targetX = 0
			targetY = 0
			wake()
		}

		window.addEventListener("pointermove", onMove, { passive: true })
		document.addEventListener("pointerleave", onLeave)
		return () => {
			window.removeEventListener("pointermove", onMove)
			document.removeEventListener("pointerleave", onLeave)
			if (raf) cancelAnimationFrame(raf)
		}
	}, [])

	/* Park every animation while the hero is off screen: nothing below the fold
	   should be paying for orbits, grain and drift it cannot see. */
	useEffect(() => {
		const root = rootRef.current
		if (!root || typeof IntersectionObserver === "undefined") return

		const observer = new IntersectionObserver(
			([entry]) => root.classList.toggle("is-idle", !entry.isIntersecting),
			{ rootMargin: "120px" },
		)
		observer.observe(root)
		return () => observer.disconnect()
	}, [])

	/* Scroll parallax: 0 at the top of the hero, 1 once it has fully left. */
	useEffect(() => {
		const root = rootRef.current
		if (!root) return
		if (pinned) return /* the scene owns the timeline and writes --nvh-out */
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return

		let raf = 0
		let height = root.offsetHeight || 1
		const measure = () => {
			height = root.offsetHeight || 1
		}
		const frame = () => {
			raf = 0
			const progress = Math.min(1, Math.max(0, window.scrollY / height))
			root.style.setProperty("--nvh-scroll", progress.toFixed(4))
		}
		const onScroll = () => {
			if (!raf) raf = requestAnimationFrame(frame)
		}

		const onResize = () => {
			measure()
			onScroll()
		}

		frame()
		window.addEventListener("scroll", onScroll, { passive: true })
		window.addEventListener("resize", onResize)
		return () => {
			window.removeEventListener("scroll", onScroll)
			window.removeEventListener("resize", onResize)
			if (raf) cancelAnimationFrame(raf)
		}
	}, [pinned])

	return (
		<section
			className={`nvh${mounted ? " is-in" : ""}${pinned ? " is-pinned" : ""}`}
			ref={rootRef}
			id="top"
			aria-label="NOVA"
		>
			<HeroEnvironment />

			<div className="nvh-layer nvh-layer-orbits" aria-hidden="true">
				<OrbitSystem />
			</div>

			<div className="nvh-frame">
				<HeroBrand />
				<HeroStatus mode={mode} />

				<div className="nvh-stage">
					<HeroTitle />
					<HeroAnnotations tenantName={tenantName} />
					<KnowledgeCore />

					<div className="nvh-actions">
						<DemoPortal label={ctaLabel} onClick={onEnter} />
						<div className="nvh-actions-secondary">
							<HeroOnboardLink onClick={onOnboard} />
							<HeroScrollCue onClick={onScrollNext} />
						</div>
					</div>
				</div>

				<HeroBottomStrip />
			</div>
		</section>
	)
}
