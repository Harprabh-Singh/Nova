import { useEffect, useRef, useState, type ReactNode } from "react"
import "../anim.css"

/* ============================================================================
   NOVA motion toolkit
   Hand-rolled equivalents of the GSAP/ScrollTrigger/SplitType/Lenis patterns
   used across the site. Everything here obeys the same rules:

   - animate only `transform`, `opacity` and `clip-path`
   - never animate `filter: blur()`, `width`, `height`, `top` or `left`
   - per-frame work writes straight to the DOM, never through React state
   - one rAF loop per effect, parked while idle, `{ passive: true }` listeners
   ========================================================================== */

/* ------------------------------------------------------------------ easing */

export const remap = (p: number, start: number, end: number) =>
	Math.max(0, Math.min((p - start) / (end - start), 1))

export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)
export const easeOutQuad = (t: number) => 1 - Math.pow(1 - t, 2)
export const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t))
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

export const SPRING = "cubic-bezier(0.34, 1.56, 0.64, 1)"
export const EXPO = "cubic-bezier(0.16, 1, 0.3, 1)"

const reducedMotion = () =>
	typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches

/* ------------------------------------------------------- scroll progress */

type ProgressOptions = {
	/** Damping per frame. Lower = more lag, like GSAP's `scrub: 1`. Default 0.14. */
	scrub?: number
	/** "cover" = enters bottom → leaves top. "pin" = top-top → bottom-bottom. */
	mode?: "pin" | "cover"
}

/**
 * Scroll-scrubbed progress for a section, delivered per animation frame.
 * `onUpdate` receives 0→1 and must only write transforms/opacity.
 */
export function useScrollProgress(
	ref: React.RefObject<HTMLElement | null>,
	onUpdate: (progress: number) => void,
	{ scrub = 0.14, mode = "pin" }: ProgressOptions = {},
) {
	const cbRef = useRef(onUpdate)
	cbRef.current = onUpdate

	useEffect(() => {
		const el = ref.current
		if (!el) return

		let raf = 0
		let idle = 0
		let current = 0
		let target = 0
		const instant = reducedMotion()

		const read = () => {
			const rect = el.getBoundingClientRect()
			if (mode === "cover") {
				const total = window.innerHeight + rect.height
				target = Math.min(1, Math.max(0, (window.innerHeight - rect.top) / total))
			} else {
				const total = el.offsetHeight - window.innerHeight
				target = Math.min(1, Math.max(0, -rect.top / Math.max(1, total)))
			}
		}

		const tick = () => {
			read()
			const delta = target - current
			current = instant || Math.abs(delta) < 0.0002 ? target : current + delta * scrub
			cbRef.current(current)
			if (Math.abs(target - current) < 0.0002) {
				idle += 1
				if (idle > 24) {
					raf = 0
					return
				}
			} else {
				idle = 0
			}
			raf = requestAnimationFrame(tick)
		}

		const wake = () => {
			idle = 0
			if (!raf) raf = requestAnimationFrame(tick)
		}

		read()
		current = target
		wake()
		window.addEventListener("scroll", wake, { passive: true })
		window.addEventListener("resize", wake)
		return () => {
			if (raf) cancelAnimationFrame(raf)
			window.removeEventListener("scroll", wake)
			window.removeEventListener("resize", wake)
		}
	}, [ref, scrub, mode])
}

/* ------------------------------------------------------------- in view once */

export function useInView<T extends HTMLElement>(threshold = 0.25) {
	const ref = useRef<T | null>(null)
	const [inView, setInView] = useState(false)

	useEffect(() => {
		const node = ref.current
		if (!node) return
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						setInView(true)
						observer.disconnect()
					}
				}
			},
			{ threshold, rootMargin: "0px 0px -8% 0px" },
		)
		observer.observe(node)
		return () => observer.disconnect()
	}, [threshold])

	return [ref, inView] as const
}

/* --------------------------------------------------------------- text split */

type SplitKind = "chars" | "words"

/** Wraps each char/word in a span so it can be transformed individually. */
function splitText(el: HTMLElement, kind: SplitKind): HTMLElement[] {
	const source = el.dataset.splitSource ?? el.textContent ?? ""
	el.dataset.splitSource = source
	el.textContent = ""
	const pieces: HTMLElement[] = []

	for (const word of source.split(/(\s+)/)) {
		if (!word) continue
		if (/^\s+$/.test(word)) {
			el.appendChild(document.createTextNode(" "))
			continue
		}
		const wordEl = document.createElement("span")
		wordEl.className = "an-word"
		if (kind === "words") {
			wordEl.textContent = word
			pieces.push(wordEl)
		} else {
			for (const char of Array.from(word)) {
				const charEl = document.createElement("span")
				charEl.className = "an-char"
				charEl.textContent = char
				wordEl.appendChild(charEl)
				pieces.push(charEl)
			}
		}
		el.appendChild(wordEl)
	}
	return pieces
}

/**
 * Character reveal: chars start below a clipped line with a slight 3D tilt and
 * rise into place, staggered. Equivalent of SplitType + `expo.out` stagger.
 */
export function useCharReveal(
	ref: React.RefObject<HTMLElement | null>,
	{ delay = 0.1, stagger = 0.024, enabled = true }: { delay?: number; stagger?: number; enabled?: boolean } = {},
) {
	useEffect(() => {
		const el = ref.current
		if (!el || !enabled) return
		if (reducedMotion()) {
			el.classList.add("an-revealed")
			return
		}

		const chars = splitText(el, "chars")
		chars.forEach((char, i) => {
			char.style.transitionDelay = `${delay + i * stagger}s`
		})
		el.classList.add("an-split")

		let raf = 0
		let observer: IntersectionObserver | null = null
		observer = new IntersectionObserver(
			(entries) => {
				if (!entries.some((e) => e.isIntersecting)) return
				observer?.disconnect()
				raf = requestAnimationFrame(() => el.classList.add("an-revealed"))
			},
			{ threshold: 0.2 },
		)
		observer.observe(el)

		return () => {
			observer?.disconnect()
			if (raf) cancelAnimationFrame(raf)
		}
	}, [ref, delay, stagger, enabled])
}

/**
 * Scroll-lit words: each word sits at opacity 0.12 and lights up in sequence as
 * the section is scrubbed, like reading by torchlight.
 */
export function useWordLight(
	sectionRef: React.RefObject<HTMLElement | null>,
	textRef: React.RefObject<HTMLElement | null>,
) {
	const wordsRef = useRef<HTMLElement[]>([])

	useEffect(() => {
		const el = textRef.current
		if (!el) return
		wordsRef.current = splitText(el, "words")
		el.classList.add("an-lit")
		wordsRef.current.forEach((w) => (w.style.opacity = "0.12"))
	}, [textRef])

	useScrollProgress(
		sectionRef,
		(p) => {
			const words = wordsRef.current
			if (!words.length) return
			/* Each word gets its own slice of the scroll, with overlap. */
			const span = 1 / words.length
			for (let i = 0; i < words.length; i++) {
				const t = remap(p, i * span * 0.85, i * span * 0.85 + span * 2.2)
				words[i].style.opacity = String(0.12 + 0.88 * t)
			}
		},
		{ scrub: 0.16 },
	)
}

/* ---------------------------------------------------------------- 3D tilt */

/** Mouse parallax tilt with a cursor-following shadow. Returns handlers. */
export function useTilt({ max = 10, scale = 1.02 }: { max?: number; scale?: number } = {}) {
	const ref = useRef<HTMLDivElement | null>(null)

	const onMouseMove = (event: React.MouseEvent) => {
		const el = ref.current
		if (!el || reducedMotion()) return
		const rect = el.getBoundingClientRect()
		const x = (event.clientX - rect.left) / rect.width - 0.5
		const y = (event.clientY - rect.top) / rect.height - 0.5
		el.style.transform = `perspective(900px) rotateX(${-y * max}deg) rotateY(${x * max}deg) scale(${scale})`
		el.style.setProperty("--tilt-x", String(x))
		el.style.setProperty("--tilt-y", String(y))
	}

	const onMouseLeave = () => {
		const el = ref.current
		if (!el) return
		el.style.transform = "perspective(900px) rotateX(0deg) rotateY(0deg) scale(1)"
		el.style.setProperty("--tilt-x", "0")
		el.style.setProperty("--tilt-y", "0")
	}

	return { ref, onMouseMove, onMouseLeave }
}

/* ------------------------------------------------------------- entrances */

/** Scroll entrance with optional stagger index. Plays once. */
export function Rise({
	children,
	delay = 0,
	className = "",
	as: Tag = "div",
}: {
	children: ReactNode
	delay?: number
	className?: string
	as?: "div" | "li" | "article" | "section"
}) {
	const [ref, inView] = useInView<HTMLDivElement>(0.16)
	return (
		<Tag
			ref={ref as React.RefObject<any>}
			className={`an-rise ${inView ? "in" : ""} ${className}`}
			style={{ transitionDelay: `${delay}s` }}
		>
			{children}
		</Tag>
	)
}

/** Counter that eases to its target when scrolled into view. */
export function Counter({ to, suffix = "", duration = 1500 }: { to: number; suffix?: string; duration?: number }) {
	const [ref, inView] = useInView<HTMLSpanElement>(0.4)
	const [value, setValue] = useState(0)

	useEffect(() => {
		if (!inView) return
		if (reducedMotion()) {
			setValue(to)
			return
		}
		let raf = 0
		const start = performance.now()
		const tick = (now: number) => {
			const t = Math.min(1, (now - start) / duration)
			setValue(Math.round(to * easeOutExpo(t)))
			if (t < 1) raf = requestAnimationFrame(tick)
		}
		raf = requestAnimationFrame(tick)
		return () => cancelAnimationFrame(raf)
	}, [inView, to, duration])

	return (
		<span ref={ref}>
			{value.toLocaleString()}
			{suffix}
		</span>
	)
}

/* ------------------------------------------------- inertial wheel scrolling */

/**
 * Lenis-style smooth scrolling. Wheel deltas move a virtual target and the page
 * eases toward it. Touch, keyboard and scrollbar input stay native, and the
 * scroller stands down while another component has the page locked.
 * Returns an imperative `scrollTo(y)` for anchor navigation.
 */
export function useSmoothScroll() {
	const apiRef = useRef<(y: number) => void>(() => {})

	useEffect(() => {
		if (typeof window === "undefined") return
		const reduced = reducedMotion()
		const touch = window.matchMedia("(hover: none)").matches
		const root = document.documentElement
		const previousBehavior = root.style.scrollBehavior

		if (reduced || touch) {
			apiRef.current = (y) => window.scrollTo({ top: y, behavior: reduced ? "auto" : "smooth" })
			return
		}

		/* Native smooth scrolling fights per-frame scrollTo calls. */
		root.style.scrollBehavior = "auto"

		let target = window.scrollY
		let expected = window.scrollY
		let animating = false
		let raf = 0
		let ease = 0.14

		const maxScroll = () => Math.max(0, root.scrollHeight - window.innerHeight)
		const locked = () => document.body.style.overflow === "hidden"

		const stop = () => {
			animating = false
			if (raf) cancelAnimationFrame(raf)
			raf = 0
		}

		const tick = () => {
			const y = window.scrollY
			const delta = target - y
			if (Math.abs(delta) < 0.4) {
				window.scrollTo(0, target)
				expected = target
				stop()
				return
			}
			window.scrollTo(0, y + delta * ease)
			expected = window.scrollY
			raf = requestAnimationFrame(tick)
		}

		const start = (next: number, easing: number) => {
			target = Math.min(maxScroll(), Math.max(0, next))
			ease = easing
			animating = true
			if (!raf) raf = requestAnimationFrame(tick)
		}

		const onWheel = (event: WheelEvent) => {
			if (locked() || event.ctrlKey || event.defaultPrevented) return
			const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1
			/* Inside a horizontally-driven section, a sideways trackpad swipe should
			   move the story too, so the dominant axis wins. */
			const node = event.target instanceof Element ? event.target : null
			const horizontal =
				Math.abs(event.deltaX) > Math.abs(event.deltaY) && !!node?.closest("[data-hscroll]")
			const delta = horizontal ? event.deltaX : event.deltaY
			event.preventDefault()
			start((animating ? target : window.scrollY) + delta * unit, 0.14)
		}

		/* Adopt any externally driven scroll instead of dragging it back. */
		const onScroll = () => {
			if (!animating) {
				target = window.scrollY
				expected = window.scrollY
				return
			}
			if (Math.abs(window.scrollY - expected) > 8) {
				target = window.scrollY
				stop()
			}
		}

		apiRef.current = (y) => start(y, 0.085)
		window.addEventListener("wheel", onWheel, { passive: false })
		window.addEventListener("scroll", onScroll, { passive: true })
		return () => {
			window.removeEventListener("wheel", onWheel)
			window.removeEventListener("scroll", onScroll)
			stop()
			root.style.scrollBehavior = previousBehavior
		}
	}, [])

	return apiRef
}
