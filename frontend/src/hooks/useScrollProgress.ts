import { useEffect, useRef, useState, type RefObject } from "react"

/* ============================================================================
   Shared scroll progress

   One normalised value drives the whole hero -> proof transformation:

     0.00  the hero still owns the frame
     0.25  the transition begins (documents start travelling)
     0.50  orbitals flatten into evidence traces, the core dims
     0.75  the proof typography settles, ANSWER TRACE powers on
     1.00  section 02 is fully established

   The value is published as a CSS custom property once per animation frame
   instead of being pushed through React state, so a hundred layers can read it
   without a single re-render. Only the coarse phase (used to switch text /
   aria state) is lifted into React.
   ========================================================================== */

export function clamp01(value: number): number {
	return value < 0 ? 0 : value > 1 ? 1 : value
}

export function lerp(from: number, to: number, t: number): number {
	return from + (to - from) * t
}

/** Remap a value from one range to another, clamped at both ends. */
export function mapRange(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
	if (inMax === inMin) return outMin
	return lerp(outMin, outMax, clamp01((value - inMin) / (inMax - inMin)))
}

type ScrollProgressOptions = {
	/** CSS custom property written on the tracked element. */
	varName?: string
	/** Ascending thresholds; the active index is reported through onPhase. */
	phases?: number[]
	onPhase?: (phase: number) => void
}

/**
 * Track how far a tall "scene track" has scrolled through the viewport.
 *
 * progress 0 = the track's top edge is at the top of the viewport
 * progress 1 = the track's bottom edge is at the bottom of the viewport
 *
 * With `prefers-reduced-motion` the scene is pinned at its established state
 * (progress 1) and no listeners are attached: the content is all still there,
 * it simply does not move.
 */
export function useScrollProgress(ref: RefObject<HTMLElement | null>, options: ScrollProgressOptions = {}): void {
	const { varName = "--pf", phases, onPhase } = options
	const phaseRef = useRef(-1)

	useEffect(() => {
		const element = ref.current
		if (!element) return

		const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
		if (reduced) {
			element.style.setProperty(varName, "1")
			if (phases && onPhase) onPhase(phases.length)
			return
		}

		let raf = 0
		let visible = true
		/* The published value chases the raw scroll value instead of snapping to
		   it. A wheel notch is a step function; this turns the step into a short
		   glide, which is the difference between "jumpy" and "filmed". */
		let smoothed = -1

		const frame = () => {
			raf = 0
			const rect = element.getBoundingClientRect()
			const span = element.offsetHeight - window.innerHeight
			const target = span > 0 ? clamp01(-rect.top / span) : rect.top < 0 ? 1 : 0

			if (smoothed < 0) smoothed = target
			const delta = target - smoothed
			smoothed = Math.abs(delta) < 0.0004 ? target : smoothed + delta * 0.16
			const progress = smoothed
			element.style.setProperty(varName, progress.toFixed(4))
			/* Keep running until the glide has caught up with the scroll. */
			if (progress !== target && visible) raf = requestAnimationFrame(frame)

			if (phases && onPhase) {
				let phase = 0
				for (const threshold of phases) if (progress >= threshold) phase += 1
				if (phase !== phaseRef.current) {
					phaseRef.current = phase
					onPhase(phase)
				}
			}
		}

		const schedule = () => {
			if (!raf && visible) raf = requestAnimationFrame(frame)
		}

		/* Nothing off screen pays for the scene. */
		const observer =
			typeof IntersectionObserver === "undefined"
				? null
				: new IntersectionObserver(
						([entry]) => {
							visible = entry.isIntersecting
							if (visible) schedule()
						},
						{ rootMargin: "25% 0px" },
				  )
		observer?.observe(element)

		frame()
		window.addEventListener("scroll", schedule, { passive: true })
		window.addEventListener("resize", schedule)
		return () => {
			window.removeEventListener("scroll", schedule)
			window.removeEventListener("resize", schedule)
			observer?.disconnect()
			if (raf) cancelAnimationFrame(raf)
		}
	}, [ref, varName, onPhase, phases])
}

/**
 * Coarse phase of the hero -> proof transition, for the few things that are
 * genuinely stateful (the ANSWER TRACE power-on sequence, aria-live copy).
 */
export function useTransitionPhase(ref: RefObject<HTMLElement | null>, phases: number[]): number {
	const [phase, setPhase] = useState(0)
	const thresholds = useRef(phases)
	useScrollProgress(ref, { phases: thresholds.current, onPhase: setPhase })
	return phase
}
