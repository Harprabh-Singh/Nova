import { useEffect, useRef } from "react"
import { FinalCtaEnvironment } from "./FinalCtaEnvironment.tsx"
import { FinalCtaBrand } from "./FinalCtaBrand.tsx"
import { FinalCtaHeading } from "./FinalCtaHeading.tsx"
import { FinalCtaButtons } from "./FinalCtaButtons.tsx"
import { FinalCtaAnnotations } from "./FinalCtaAnnotations.tsx"
import { FinalCtaFooter } from "./FinalCtaFooter.tsx"
import type { HeroRuntimeMode } from "../hero/HeroStatus.tsx"
import "../../styles/final-cta.css"

/* ============================================================================
   NOVA — THE THRESHOLD (closing CTA)

   The last room in the building, and deliberately the quietest one. Every
   earlier section added objects — documents, plaques, evidence bays. This one
   removes them: two walls, an opening, a reflective floor, and one sentence.

   The handover from the evidence wall is continuous. The bays' vertical
   dividers arrive as the framing rules at the top of this section and then
   fall away, the grade starts on the previous section's closing value, and
   the lime survives only as small signals.

   No 3D. Depth is architecture, light, reflection, shadow and a 3px parallax
   on the room — never on the typography, which stays fixed.
   ========================================================================== */

export function FinalCtaSection({
	mode,
	onEnter,
	onOnboard,
}: {
	mode: HeroRuntimeMode
	onEnter: () => void
	onOnboard: () => void
}) {
	const ref = useRef<HTMLElement>(null)

	/* A few pixels of room parallax, driven by the cursor and written straight
	   to CSS variables in one rAF. The typography never moves — only the
	   architecture behind it. Disabled entirely under reduced motion. */
	useEffect(() => {
		const el = ref.current
		if (!el) return
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
		if (window.matchMedia("(max-width: 860px)").matches) return

		let raf = 0
		let x = 0
		let y = 0

		const apply = () => {
			raf = 0
			el.style.setProperty("--f-px", `${x.toFixed(2)}px`)
			el.style.setProperty("--f-py", `${y.toFixed(2)}px`)
		}

		const onMove = (event: PointerEvent) => {
			const rect = el.getBoundingClientRect()
			if (rect.bottom < 0 || rect.top > window.innerHeight) return
			x = ((event.clientX - rect.left) / rect.width - 0.5) * -6
			y = ((event.clientY - rect.top) / rect.height - 0.5) * -4
			if (!raf) raf = requestAnimationFrame(apply)
		}

		window.addEventListener("pointermove", onMove, { passive: true })
		return () => {
			window.removeEventListener("pointermove", onMove)
			if (raf) cancelAnimationFrame(raf)
		}
	}, [])

	return (
		<section className="fct" id="start" aria-labelledby="fct-title" ref={ref}>
			<FinalCtaEnvironment />

			{/* The evidence wall's dividers, continuing down and dissolving. */}
			<div className="fct-seam" aria-hidden="true" />

			<div className="fct-inner">
				<FinalCtaBrand mode={mode} />

				<div className="fct-stage">
					<span className="fct-label">Get started</span>

					<FinalCtaHeading />

					<p className="fct-copy">
						Pick a demo persona and start interrogating the knowledge base, or onboard your own company with its
						documents, roles and permissions.
					</p>

					<FinalCtaButtons onEnter={onEnter} onOnboard={onOnboard} />
				</div>

				<FinalCtaAnnotations />
				<FinalCtaFooter />
			</div>
		</section>
	)
}
