/* ==========================================================================
   NOVA — motion extensions
   Built in the same spirit as lib/anim.tsx: tiny, imperative, rAF-based, and
   always inert under prefers-reduced-motion. These are the primitives the old
   file did not have — cursor spotlights, magnetic hover, staggered list
   entrances and a stepped pipeline clock.
   ========================================================================== */

import { useEffect, useRef, useState } from "react"

const reducedMotion = () =>
	typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches

/**
 * Cursor spotlight. Writes `--sx` / `--sy` (0–1 within the element) on an
 * animation frame so CSS can position a radial highlight without React
 * re-rendering. Lerped so the light trails the pointer slightly.
 */
export function useSpotlight<T extends HTMLElement>() {
	const ref = useRef<T | null>(null)

	useEffect(() => {
		const el = ref.current
		if (!el || reducedMotion()) return

		let raf = 0
		let tx = 0.5
		let ty = 0.3
		let x = tx
		let y = ty
		let running = false

		const frame = () => {
			x += (tx - x) * 0.1
			y += (ty - y) * 0.1
			el.style.setProperty("--sx", x.toFixed(4))
			el.style.setProperty("--sy", y.toFixed(4))
			if (Math.abs(tx - x) < 0.001 && Math.abs(ty - y) < 0.001) {
				running = false
				raf = 0
				return
			}
			raf = requestAnimationFrame(frame)
		}

		const onMove = (event: PointerEvent) => {
			const rect = el.getBoundingClientRect()
			tx = (event.clientX - rect.left) / Math.max(1, rect.width)
			ty = (event.clientY - rect.top) / Math.max(1, rect.height)
			if (!running) {
				running = true
				raf = requestAnimationFrame(frame)
			}
		}

		window.addEventListener("pointermove", onMove, { passive: true })
		return () => {
			window.removeEventListener("pointermove", onMove)
			if (raf) cancelAnimationFrame(raf)
		}
	}, [])

	return ref
}

/**
 * Magnetic hover. The element leans a few pixels toward the cursor and its
 * children can offset further via `--mx` / `--my`, which reads as weight
 * rather than a bouncy scale.
 */
export function useMagnet({ strength = 10 }: { strength?: number } = {}) {
	const ref = useRef<HTMLElement | null>(null)

	const onPointerMove = (event: React.PointerEvent) => {
		const el = ref.current
		if (!el || reducedMotion()) return
		const rect = el.getBoundingClientRect()
		const x = (event.clientX - rect.left) / rect.width - 0.5
		const y = (event.clientY - rect.top) / rect.height - 0.5
		el.style.setProperty("--mx", `${(x * strength).toFixed(2)}px`)
		el.style.setProperty("--my", `${(y * strength * 0.6).toFixed(2)}px`)
	}

	const onPointerLeave = () => {
		const el = ref.current
		if (!el) return
		el.style.setProperty("--mx", "0px")
		el.style.setProperty("--my", "0px")
	}

	return { ref, onPointerMove, onPointerLeave }
}

/**
 * Staggered mount entrance for lists. Returns a class and an inline delay for
 * item `index`; the parent decides when the run starts by changing `key`.
 */
export function stagger(index: number, step = 0.055, base = 0.04) {
	return { className: "mo-in", style: { animationDelay: `${base + index * step}s` } as React.CSSProperties }
}

/**
 * Pipeline clock. Advances through `count` stages on a fixed interval while
 * `active`, so a waiting state can narrate RETRIEVE → VERIFY → CITE → ACT
 * instead of showing three bouncing dots. Stops at the last stage.
 */
export function usePipelineStage(active: boolean, count: number, everyMs = 620) {
	const [stage, setStage] = useState(0)

	useEffect(() => {
		if (!active) {
			setStage(0)
			return
		}
		if (reducedMotion()) {
			setStage(count - 1)
			return
		}
		const id = window.setInterval(() => {
			setStage((current) => (current >= count - 1 ? current : current + 1))
		}, everyMs)
		return () => window.clearInterval(id)
	}, [active, count, everyMs])

	return stage
}

/**
 * Measures an element and animates its height when content changes, so panels
 * growing (citations arriving, a file list appearing) do not snap.
 */
export function useAutoHeight<T extends HTMLElement>(dependency: unknown) {
	const ref = useRef<T | null>(null)
	const previous = useRef<number | null>(null)

	useEffect(() => {
		const el = ref.current
		if (!el || reducedMotion()) return
		const next = el.scrollHeight
		const last = previous.current
		previous.current = next
		if (last === null || last === next) return

		el.style.overflow = "hidden"
		el.style.height = `${last}px`
		const raf = requestAnimationFrame(() => {
			el.style.transition = "height 0.34s cubic-bezier(0.16, 1, 0.3, 1)"
			el.style.height = `${next}px`
		})
		const clear = window.setTimeout(() => {
			el.style.transition = ""
			el.style.height = ""
			el.style.overflow = ""
		}, 400)
		return () => {
			cancelAnimationFrame(raf)
			window.clearTimeout(clear)
		}
	}, [dependency])

	return ref
}
