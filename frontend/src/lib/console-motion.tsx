/* ==========================================================================
   NOVA - console motion
   A second motion layer, written in the same spirit as lib/anim.tsx and
   lib/motion.tsx: tiny, imperative, rAF-driven, and inert under
   prefers-reduced-motion. These are the primitives the data-heavy console
   pages need - counters, reading-band lighting, spring indicators, drag pans,
   clip wipes, printed logs and receipts.
   ========================================================================== */

import { useCallback, useEffect, useRef, useState } from "react"
import "../styles/console-motion.css"

const reducedMotion = () =>
	typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches

const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t))

/**
 * Counts a number up on an animation frame with an expo ease, so figures
 * settle instead of snapping. Returns the live value.
 */
export function useCounter(to: number, { duration = 900, from }: { duration?: number; from?: number } = {}) {
	const [value, setValue] = useState(from ?? 0)
	const fromRef = useRef(from ?? 0)

	useEffect(() => {
		if (reducedMotion()) {
			fromRef.current = to
			setValue(to)
			return
		}

		const start = performance.now()
		const origin = fromRef.current
		const delta = to - origin
		let raf = requestAnimationFrame(function frame(now) {
			const t = Math.min(1, (now - start) / duration)
			setValue(origin + delta * easeOutExpo(t))
			if (t < 1) raf = requestAnimationFrame(frame)
			else fromRef.current = to
		})

		return () => cancelAnimationFrame(raf)
	}, [to, duration])

	return value
}

/** Same clock, rounded - for counts of documents, people, refusals. */
export function useCountInt(to: number, options?: { duration?: number }) {
	return Math.round(useCounter(to, options))
}

/**
 * Staggered entrance for a group of rows. Any descendant marked `[data-reveal]`
 * gets `cm-row` plus an incremental transition delay, then `is-in` once the
 * group scrolls into view. Changing `dependency` replays the run, so filtering
 * a ledger re-deals the rows.
 */
export function useRevealGroup<T extends HTMLElement>(dependency: unknown, step = 0.045) {
	const ref = useRef<T | null>(null)

	useEffect(() => {
		const el = ref.current
		if (!el) return
		const rows = Array.from(el.querySelectorAll<HTMLElement>("[data-reveal]"))
		if (!rows.length) return

		if (reducedMotion()) {
			rows.forEach((row) => row.classList.add("cm-row", "is-in"))
			return
		}

		rows.forEach((row, index) => {
			row.classList.add("cm-row")
			row.classList.remove("is-in")
			if (!row.style.transitionDelay) row.style.transitionDelay = `${index * step}s`
		})

		const observer = new IntersectionObserver(
			(entries) => {
				entries.forEach((entry) => {
					if (!entry.isIntersecting) return
					entry.target.classList.add("is-in")
					observer.unobserve(entry.target)
				})
			},
			{ threshold: 0.08, rootMargin: "0px 0px -6% 0px" },
		)
		rows.forEach((row) => observer.observe(row))

		return () => observer.disconnect()
	}, [dependency, step])

	return ref
}

/**
 * Torchlight for long lists. Rows marked `[data-lit]` get a `--lit` value
 * between 0.34 and 1 based on their distance from a reading band near the top
 * third of the viewport, so the row you are actually reading is the brightest.
 * Parks itself after three idle frames.
 */
export function useLitRows<T extends HTMLElement>(dependency: unknown) {
	const ref = useRef<T | null>(null)

	useEffect(() => {
		const el = ref.current
		if (!el || reducedMotion()) return

		let raf = 0
		let idle = 0

		const paint = () => {
			const rows = el.querySelectorAll<HTMLElement>("[data-lit]")
			const band = window.innerHeight * 0.36
			let moved = false
			rows.forEach((row) => {
				const rect = row.getBoundingClientRect()
				const centre = rect.top + rect.height / 2
				const distance = Math.abs(centre - band)
				const lit = Math.max(0.34, 1 - distance / (window.innerHeight * 0.72))
				const previous = row.style.getPropertyValue("--lit")
				const next = lit.toFixed(3)
				if (previous !== next) {
					row.style.setProperty("--lit", next)
					moved = true
				}
			})
			idle = moved ? 0 : idle + 1
			if (idle > 3) {
				raf = 0
				return
			}
			raf = requestAnimationFrame(paint)
		}

		const wake = () => {
			idle = 0
			if (!raf) raf = requestAnimationFrame(paint)
		}

		wake()
		const scroller = el.closest(".wx-scroll") ?? window
		scroller.addEventListener("scroll", wake, { passive: true })
		window.addEventListener("resize", wake, { passive: true })

		return () => {
			scroller.removeEventListener("scroll", wake)
			window.removeEventListener("resize", wake)
			if (raf) cancelAnimationFrame(raf)
		}
	}, [dependency])

	return ref
}

/**
 * Measures the active `[data-tab]` and writes `--ix` / `--iw`, so a single
 * hairline springs between tabs rather than each tab owning a border.
 */
export function useSlidingIndicator<T extends HTMLElement>(activeKey: unknown) {
	const ref = useRef<T | null>(null)

	useEffect(() => {
		const el = ref.current
		if (!el) return

		const measure = () => {
			const active = el.querySelector<HTMLElement>("[data-tab].is-active")
			if (!active) return
			const host = el.getBoundingClientRect()
			const rect = active.getBoundingClientRect()
			el.style.setProperty("--ix", `${(rect.left - host.left + el.scrollLeft).toFixed(1)}px`)
			el.style.setProperty("--iw", `${rect.width.toFixed(1)}px`)
		}

		const raf = requestAnimationFrame(measure)
		window.addEventListener("resize", measure, { passive: true })
		return () => {
			cancelAnimationFrame(raf)
			window.removeEventListener("resize", measure)
		}
	}, [activeKey])

	return ref
}

/**
 * Pointer drag panning with inertial glide, for filter rails that overflow.
 * Adds `is-dragging` while held so text selection stays off.
 */
export function useDragPan<T extends HTMLElement>() {
	const ref = useRef<T | null>(null)

	useEffect(() => {
		const el = ref.current
		if (!el) return

		let down = false
		let startX = 0
		let startScroll = 0
		let velocity = 0
		let lastX = 0
		let raf = 0

		const glide = () => {
			velocity *= 0.92
			el.scrollLeft -= velocity
			if (Math.abs(velocity) > 0.4) raf = requestAnimationFrame(glide)
			else raf = 0
		}

		const onDown = (event: PointerEvent) => {
			down = true
			startX = event.clientX
			lastX = event.clientX
			startScroll = el.scrollLeft
			velocity = 0
			if (raf) cancelAnimationFrame(raf)
			raf = 0
		}

		const onMove = (event: PointerEvent) => {
			if (!down) return
			const delta = event.clientX - startX
			if (Math.abs(delta) > 3) el.classList.add("is-dragging")
			el.scrollLeft = startScroll - delta
			velocity = event.clientX - lastX
			lastX = event.clientX
		}

		const onUp = () => {
			if (!down) return
			down = false
			el.classList.remove("is-dragging")
			if (!reducedMotion() && Math.abs(velocity) > 1) raf = requestAnimationFrame(glide)
		}

		el.addEventListener("pointerdown", onDown)
		window.addEventListener("pointermove", onMove, { passive: true })
		window.addEventListener("pointerup", onUp)

		return () => {
			el.removeEventListener("pointerdown", onDown)
			window.removeEventListener("pointermove", onMove)
			window.removeEventListener("pointerup", onUp)
			if (raf) cancelAnimationFrame(raf)
		}
	}, [])

	return ref
}

/**
 * Prints log lines one at a time while `active`, so a waiting state reads like
 * equipment reporting progress. Returns how many lines should be shown.
 */
export function useLogPrinter(active: boolean, lines: ReadonlyArray<string>, everyMs = 460) {
	const [count, setCount] = useState(0)

	useEffect(() => {
		if (!active) {
			setCount(0)
			return
		}
		if (reducedMotion()) {
			setCount(lines.length)
			return
		}
		setCount(1)
		const id = window.setInterval(() => {
			setCount((current) => (current >= lines.length ? current : current + 1))
		}, everyMs)
		return () => window.clearInterval(id)
	}, [active, lines.length, everyMs])

	return count
}

/** Animated stroke-dashoffset for an SVG ring gauge fed a 0-1 ratio. */
export function useGauge(value: number, circumference: number) {
	const eased = useCounter(Math.max(0, Math.min(1, value)) * 1000, { duration: 1100 })
	return circumference * (1 - eased / 1000)
}

/**
 * Clip-path wipe, keyed so the animation replays whenever the watched value
 * changes - used when a drawer swaps to a different record.
 */
export function useWipe(watched: unknown) {
	return { key: `wipe-${String(watched)}`, className: "cm-wipe" }
}

/**
 * Ink bloom from the exact press point. Writes `--px` / `--py` and toggles
 * `is-bloom` for the length of the animation.
 */
export function usePressBloom() {
	const [bloom, setBloom] = useState(false)

	const onPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
		const el = event.currentTarget
		const rect = el.getBoundingClientRect()
		el.style.setProperty("--px", `${event.clientX - rect.left}px`)
		el.style.setProperty("--py", `${event.clientY - rect.top}px`)
		if (reducedMotion()) return
		setBloom(true)
		window.setTimeout(() => setBloom(false), 520)
	}, [])

	return { className: `cm-bloom${bloom ? " is-bloom" : ""}`, onPointerDown }
}

/**
 * Parallax depth for the console background. Writes `--py1` / `--py2` on the
 * scroller so the hairline grid drifts slower than the content.
 */
export function useDepthDrift<T extends HTMLElement>() {
	const ref = useRef<T | null>(null)

	useEffect(() => {
		const el = ref.current
		if (!el || reducedMotion()) return

		let raf = 0
		const paint = () => {
			raf = 0
			const top = el.scrollTop
			el.style.setProperty("--py1", `${(-top * 0.12).toFixed(1)}px`)
			el.style.setProperty("--py2", `${(-top * 0.26).toFixed(1)}px`)
		}
		const onScroll = () => {
			if (!raf) raf = requestAnimationFrame(paint)
		}

		paint()
		el.addEventListener("scroll", onScroll, { passive: true })
		return () => {
			el.removeEventListener("scroll", onScroll)
			if (raf) cancelAnimationFrame(raf)
		}
	}, [])

	return ref
}

/** A printed receipt for an action, which clears itself after a few seconds. */
export function useReceipt(timeoutMs = 4200) {
	const [receipt, setReceipt] = useState<{ id: number; text: string; tone: "ok" | "warn" } | null>(null)

	const print = useCallback(
		(text: string, tone: "ok" | "warn" = "ok") => {
			const id = Date.now()
			setReceipt({ id, text, tone })
			window.setTimeout(() => {
				setReceipt((current) => (current && current.id === id ? null : current))
			}, timeoutMs)
		},
		[timeoutMs],
	)

	const clear = useCallback(() => setReceipt(null), [])

	return { receipt, print, clear }
}
