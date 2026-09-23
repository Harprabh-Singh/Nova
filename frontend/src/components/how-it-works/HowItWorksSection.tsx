import { useCallback, useEffect, useRef, useState } from "react"
import { workflowSteps } from "../../data/workflowSteps.ts"
import { WorkflowEnvironment } from "./WorkflowEnvironment.tsx"
import { WorkflowHeader } from "./WorkflowHeader.tsx"
import { WorkflowTrack } from "./WorkflowTrack.tsx"
import { WorkflowProgress } from "./WorkflowProgress.tsx"
import "../../styles/how-it-works.css"

/* ============================================================================
   NOVA — HOW IT WORKS

   Five chapters of one continuous journey, not five cards in a carousel.

     vertical page scroll
          ↓
     section pins
          ↓
     vertical progress becomes horizontal translation
          ↓
     01 INGEST → 02 IDENTITY → 03 RETRIEVE → 04 GROUND → 05 ACT
          ↓
     section releases, normal scrolling resumes

   The per-frame work (track translation, parallax, progress signal) is damped
   in one parked rAF loop and written straight to the DOM as a CSS variable, so
   scrolling never re-renders React. Only the coarse active chapter is lifted
   into state, because that is genuinely stateful: it switches copy contrast,
   the environment's accent and the interior animations.

   Mobile keeps native horizontal swipe with scroll snapping: mapping vertical
   scroll onto horizontal travel makes a phone feel broken, not cinematic.
   No WebGL, no canvas, no 3D — CSS, SVG and one photograph of the same room.
   ========================================================================== */

const LAST = workflowSteps.length - 1
/* How much scroll the final chapter is held on screen before releasing. */
const TAIL_RATIO = 0.35

export function HowItWorksSection() {
	const sectionRef = useRef<HTMLElement>(null)
	const stageRef = useRef<HTMLDivElement>(null)
	const trackRef = useRef<HTMLDivElement>(null)
	const [active, setActive] = useState(0)
	const [mobile, setMobile] = useState(false)
	const activeRef = useRef(0)

	const setActiveIndex = useCallback((index: number) => {
		const next = Math.max(0, Math.min(LAST, index))
		if (activeRef.current === next) return
		activeRef.current = next
		setActive(next)
	}, [])

	/* ---------------------------------------------------------- breakpoint */

	useEffect(() => {
		const query = window.matchMedia("(max-width: 860px)")
		const apply = () => setMobile(query.matches)
		apply()
		query.addEventListener("change", apply)
		return () => query.removeEventListener("change", apply)
	}, [])

	/* ------------------------------------------- desktop: pinned horizontal */

	useEffect(() => {
		if (mobile) return
		const section = sectionRef.current
		const stage = stageRef.current
		const track = trackRef.current
		if (!section || !stage || !track) return

		const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches

		let raf = 0
		let idle = 0
		let current = 0
		let target = 0
		let distance = 0
		let dragging = false

		/* The section is exactly as tall as the journey needs: viewport + the
		   horizontal distance + a short hold on the final chapter. Nothing is
		   hard-coded to 500vh. */
		const measure = () => {
			distance = Math.max(0, track.scrollWidth - stage.clientWidth)
			const tail = distance > 0 ? distance * TAIL_RATIO : 0
			section.style.height = `${window.innerHeight + distance + tail}px`
		}

		const read = () => {
			const rect = section.getBoundingClientRect()
			const span = section.offsetHeight - window.innerHeight
			target = Math.min(1, Math.max(0, -rect.top / Math.max(1, span)))
		}

		/* Scroll maps 1:1 onto travel across the first (1 - TAIL) of the track,
		   then eases to a stop so the last panel settles instead of snapping. */
		const travel = (p: number) => {
			const end = 1 / (1 + TAIL_RATIO)
			if (p >= end) return 1
			const t = p / end
			return 1 - Math.pow(1 - t, 1.8)
		}

		const paint = (p: number) => {
			const eased = travel(p)
			track.style.transform = `translate3d(${-eased * distance}px, 0, 0)`
			stage.style.setProperty("--hw-p", eased.toFixed(4))
			setActiveIndex(Math.round(eased * LAST))
		}

		const tick = () => {
			read()
			const delta = target - current
			current = reduced || Math.abs(delta) < 0.0002 ? target : current + delta * (dragging ? 0.3 : 0.13)
			paint(current)
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

		const onResize = () => {
			measure()
			wake()
		}

		/* ---- drag / swipe, kept inside this section's slice of page scroll -- */

		const ratio = () => {
			const span = section.offsetHeight - window.innerHeight
			return distance > 0 ? span / distance : 0
		}

		const scrollWithin = (delta: number) => {
			const top = section.offsetTop
			const bottom = top + Math.max(0, section.offsetHeight - window.innerHeight)
			const next = window.scrollY + delta
			const clamped = Math.min(bottom, Math.max(top, next))
			if (clamped !== window.scrollY) window.scrollTo(0, clamped)
			return clamped !== next
		}

		let pointerId = -1
		let lastX = 0
		let lastT = 0
		let velocity = 0
		let glide = 0
		let moved = 0

		const stopGlide = () => {
			if (glide) cancelAnimationFrame(glide)
			glide = 0
		}

		const onPointerDown = (event: PointerEvent) => {
			if (event.pointerType === "mouse" && event.button !== 0) return
			if ((event.target as HTMLElement | null)?.closest("button, a, input, textarea")) return
			stopGlide()
			dragging = true
			pointerId = event.pointerId
			lastX = event.clientX
			lastT = performance.now()
			velocity = 0
			moved = 0
			section.classList.add("is-dragging")
		}

		const onPointerMove = (event: PointerEvent) => {
			if (!dragging || event.pointerId !== pointerId) return
			const dx = event.clientX - lastX
			if (!dx) return
			const now = performance.now()
			velocity = dx / Math.max(1, now - lastT)
			lastX = event.clientX
			lastT = now
			moved += Math.abs(dx)
			if (moved > 4) {
				if (event.cancelable) event.preventDefault()
				if (!section.hasPointerCapture(pointerId)) section.setPointerCapture(pointerId)
			}
			scrollWithin(-dx * ratio())
			wake()
		}

		const endDrag = (event: PointerEvent) => {
			if (!dragging || event.pointerId !== pointerId) return
			dragging = false
			section.classList.remove("is-dragging")
			if (section.hasPointerCapture(pointerId)) section.releasePointerCapture(pointerId)
			let v = Math.max(-4.5, Math.min(4.5, velocity)) * 16
			if (Math.abs(v) < 0.6) return
			const step = () => {
				v *= 0.94
				const atEdge = scrollWithin(-v * ratio())
				wake()
				glide = !atEdge && Math.abs(v) > 0.4 ? requestAnimationFrame(step) : 0
			}
			glide = requestAnimationFrame(step)
		}

		/* Focusing a card must never scroll the pinned stage sideways; the track
		   position is owned by the scroll math alone. */
		const onStageScroll = () => {
			if (stage.scrollLeft !== 0) stage.scrollLeft = 0
			if (stage.scrollTop !== 0) stage.scrollTop = 0
		}

		measure()
		read()
		current = target
		wake()
		window.addEventListener("scroll", wake, { passive: true })
		window.addEventListener("resize", onResize)
		stage.addEventListener("scroll", onStageScroll)
		section.addEventListener("pointerdown", onPointerDown)
		section.addEventListener("pointermove", onPointerMove, { passive: false })
		section.addEventListener("pointerup", endDrag)
		section.addEventListener("pointercancel", endDrag)

		return () => {
			if (raf) cancelAnimationFrame(raf)
			stopGlide()
			window.removeEventListener("scroll", wake)
			window.removeEventListener("resize", onResize)
			stage.removeEventListener("scroll", onStageScroll)
			section.removeEventListener("pointerdown", onPointerDown)
			section.removeEventListener("pointermove", onPointerMove)
			section.removeEventListener("pointerup", endDrag)
			section.removeEventListener("pointercancel", endDrag)
			section.style.height = ""
		}
	}, [mobile, setActiveIndex])

	/* ------------------------------------------- mobile: native swipe track */

	useEffect(() => {
		if (!mobile) return
		const stage = stageRef.current
		const track = trackRef.current
		if (!stage || !track) return
		stage.style.removeProperty("--hw-p")
		track.style.transform = ""

		let raf = 0
		const onScroll = () => {
			if (raf) return
			raf = requestAnimationFrame(() => {
				raf = 0
				const span = track.scrollWidth - track.clientWidth
				const p = span > 0 ? track.scrollLeft / span : 0
				stage.style.setProperty("--hw-p", p.toFixed(4))
				setActiveIndex(Math.round(p * LAST))
			})
		}

		onScroll()
		track.addEventListener("scroll", onScroll, { passive: true })
		return () => {
			if (raf) cancelAnimationFrame(raf)
			track.removeEventListener("scroll", onScroll)
		}
	}, [mobile, setActiveIndex])

	/* ------------------------------------------------------- chapter jumps */

	const goTo = useCallback(
		(index: number) => {
			const clamped = Math.max(0, Math.min(LAST, index))
			const section = sectionRef.current
			const track = trackRef.current
			if (!track) return

			if (mobile) {
				const card = track.children[clamped] as HTMLElement | undefined
				card?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" })
				setActiveIndex(clamped)
				return
			}
			if (!section) return

			/* Invert the travel easing so a marker lands on its own chapter. */
			const end = 1 / (1 + TAIL_RATIO)
			const eased = clamped / LAST
			const p = eased >= 1 ? 1 : (1 - Math.pow(1 - eased, 1 / 1.8)) * end
			const span = section.offsetHeight - window.innerHeight
			const to = section.offsetTop + p * span
			window.scrollTo({
				top: to,
				behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
			})
			setActiveIndex(clamped)
		},
		[mobile, setActiveIndex],
	)

	const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
		if (event.key === "ArrowRight") {
			event.preventDefault()
			goTo(active + 1)
		} else if (event.key === "ArrowLeft") {
			event.preventDefault()
			goTo(active - 1)
		}
	}

	return (
		<section
			className={`hiw${mobile ? " is-mobile" : ""}`}
			ref={sectionRef}
			data-hscroll=""
			aria-labelledby="hiw-title"
			onKeyDown={onKeyDown}
		>
			<div className="hiw-stage" ref={stageRef} data-accent={workflowSteps[active]?.accent ?? "lime"}>
				<WorkflowEnvironment />
				<div className="hiw-inner">
					<WorkflowHeader />
					<WorkflowTrack ref={trackRef} steps={workflowSteps} active={active} onActivate={setActiveIndex} />
					<WorkflowProgress steps={workflowSteps} active={active} onSelect={goTo} />
				</div>
			</div>
		</section>
	)
}
