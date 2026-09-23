import { useEffect, type RefObject } from "react"

/* ============================================================================
   Scene autoplay

   The hero -> proof transformation is a single shot, and a shot should not be
   scrubbed three lines at a time by a trackpad. When the reader is parked at
   the very top of the scene and scrolls DOWN, we take the wheel and play the
   whole thing through at a fixed, even speed. When they are parked at the end
   of the scene and scroll UP, we play it back to the top the same way.

   Everything in between stays manual: mid-scene the reader still controls the
   scrub, so nothing feels hijacked, and one more notch past the end leaves the
   scene entirely.
   ========================================================================== */

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value)

/** Slow in, fast through the middle, slow out -- a camera move, not a jump. */
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

type Options = {
	/** How long the full play-through takes, in milliseconds. */
	duration?: number
	/** How close to an end the reader must be for autoplay to take over. */
	edge?: number
}

export function useSceneAutoplay(ref: RefObject<HTMLElement | null>, options: Options = {}): void {
	const { duration = 2800, edge = 0.015 } = options

	useEffect(() => {
		const element = ref.current
		if (!element) return
		if (typeof window === "undefined") return
		/* Reduced motion and touch are left completely alone: no hijacking a
		   gesture the reader is physically driving. */
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
		if (window.matchMedia("(hover: none)").matches) return

		let raf = 0
		let playing = false

		const bounds = () => {
			const rect = element.getBoundingClientRect()
			const top = rect.top + window.scrollY
			const end = top + element.offsetHeight - window.innerHeight
			const span = end - top
			const progress = span > 0 ? clamp01((window.scrollY - top) / span) : 0
			return { top, end, progress }
		}

		const play = (target: number) => {
			const start = window.scrollY
			const distance = target - start
			if (Math.abs(distance) < 8) return
			playing = true
			const began = performance.now()
			const step = (now: number) => {
				const t = Math.min(1, (now - began) / duration)
				window.scrollTo(0, start + distance * easeInOutCubic(t))
				if (t < 1) {
					raf = requestAnimationFrame(step)
				} else {
					raf = 0
					playing = false
				}
			}
			raf = requestAnimationFrame(step)
		}

		const stop = () => {
			if (raf) cancelAnimationFrame(raf)
			raf = 0
			playing = false
		}

		const onWheel = (event: WheelEvent) => {
			if (event.ctrlKey) return /* pinch zoom */
			if (playing) {
				/* Swallow input while the shot plays so the two motions cannot
				   fight each other and stutter. */
				event.preventDefault()
				return
			}
			const { top, end, progress } = bounds()
			const down = event.deltaY > 0
			const up = event.deltaY < 0

			if (down && progress <= edge && window.scrollY >= top - 4 && window.scrollY <= top + 4) {
				event.preventDefault()
				play(end)
				return
			}
			if (up && progress >= 1 - edge && window.scrollY <= end + 4 && window.scrollY >= end - 4) {
				event.preventDefault()
				play(top)
			}
		}

		/* Any deliberate keyboard or touch input cancels an in-flight play. */
		const onKey = (event: KeyboardEvent) => {
			if (playing && event.key !== "Tab") stop()
		}

		window.addEventListener("wheel", onWheel, { passive: false })
		window.addEventListener("keydown", onKey)
		window.addEventListener("touchstart", stop, { passive: true })
		return () => {
			window.removeEventListener("wheel", onWheel)
			window.removeEventListener("keydown", onKey)
			window.removeEventListener("touchstart", stop)
			if (raf) cancelAnimationFrame(raf)
		}
	}, [ref, duration, edge])
}
