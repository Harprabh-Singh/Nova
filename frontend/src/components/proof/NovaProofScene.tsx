import { useRef, useState } from "react"
import { useScrollProgress } from "../../hooks/useScrollProgress.ts"
import { useSceneAutoplay } from "../../hooks/useSceneAutoplay.ts"
import { proofFooter, proofFooterNote, type ProofSourceId } from "../../data/proofEvidence.ts"
import { NovaHero } from "../hero/NovaHero.tsx"
import type { HeroRuntimeMode } from "../hero/HeroStatus.tsx"
import { ProofEnvironment } from "./ProofEnvironment.tsx"
import { ProofConnectors } from "./ProofConnectors.tsx"
import { ProofHeading } from "./ProofHeading.tsx"
import { EvidenceTrace } from "./EvidenceTrace.tsx"
import { ProofAnnotationStack, ProofAnnotationFloats } from "./ProofAnnotations.tsx"
import "../../styles/proof.css"

/* ============================================================================
   THE CONTINUOUS SCENE -- hero + proof chamber, one shot

   Previously the hero was its own scrolling section and the proof chamber was
   a second pinned section that re-rendered lookalike artifacts at the hero's
   last known coordinates. However carefully those were tuned, the eye read it
   correctly: two element sets, one handing over to the other. The hero never
   transformed -- it left, and a copy carried on.

   This is the structural fix. There is ONE scroll track and ONE sticky stage.
   The hero is mounted inside that stage as a layer (pinned, so it cannot
   scroll away) and the document artifacts are hoisted out of the hero and
   owned by the scene, so a single set of DOM nodes exists from the first frame
   to the last. Nothing is handed over, because nothing is duplicated:

     - the artifacts you see orbiting the core ARE the evidence artifacts
     - the hero's orbital SVG IS the trace geometry
     - the hero's environment plate IS the proof chamber's environment
     - the hero's headline recedes on the SAME clock that raises the proof copy

     0.00 - 0.06   hero at rest; the reader is simply in the room
     0.06 - 0.46   core contracts, headline lifts, artifacts begin travelling
     0.14 - 0.54   orbitals stretch, flatten, straighten into evidence traces
     0.30 - 0.42   chapter marker 02 / THE PROBLEM surfaces
     0.36 - 0.60   proof typography rises out of the architecture
     0.46 - 0.80   ANSWER TRACE powers on, stage by stage
     0.80 - 1.00   the system settles; the room is fully editorial

   Motion is CSS-side off one custom property (--pf), so the whole scene costs
   one rAF write per frame and zero React renders. Only the trace power-on and
   the artifact focus link are stateful.
   ========================================================================== */

/** Thresholds at which the trace instrument lights another stage. */
const POWER_PHASES = [0.52, 0.62, 0.71, 0.8]

type Props = {
	mode: HeroRuntimeMode
	tenantName: string
	ctaLabel: string
	onEnter: () => void
	onOnboard: () => void
	onScrollNext: () => void
}

export function NovaProofScene({ mode, tenantName, ctaLabel, onEnter, onOnboard, onScrollNext }: Props) {
	const trackRef = useRef<HTMLElement>(null)
	const [phase, setPhase] = useState(0)
	const [active, setActive] = useState<ProofSourceId | null>(null)

	useScrollProgress(trackRef, { varName: "--pf", phases: POWER_PHASES, onPhase: setPhase })
	/* From the top, one scroll down plays the whole shot; from the end, one
	   scroll up plays it back to the hero. Mid-scene stays manual. */
	useSceneAutoplay(trackRef)

	return (
		<section className="pfc" id="why" ref={trackRef} aria-labelledby="pfc-heading">
			<div className="pfc-stage">
				{/* The hero, pinned. It does not leave the frame -- it recedes inside
				    it, on the same timeline as everything else in the room. */}
				<div className={`pfc-hero${phase > 0 ? " is-past" : ""}`}>
					<NovaHero
						pinned
						mode={mode}
						tenantName={tenantName}
						ctaLabel={ctaLabel}
						onEnter={onEnter}
						onOnboard={onOnboard}
						onScrollNext={onScrollNext}
					/>
				</div>

				{/* The same architecture, graded deeper. It rises through the hero's
				    own plate rather than replacing it. */}
				<ProofEnvironment />
				<ProofConnectors active={active} />

				{/* The hero's CTA, continuing: the circular portal has travelled down
				    the frame and shrunk into a system marker. It stays hidden until
				    the hero's own portal has gone, so the two never read as two
				    buttons stacked on each other. */}
				<div className="pfc-marker-cta" aria-hidden="true">
					<span className="pfc-marker-ring" />
					SYSTEM / LIVE
				</div>

				<div className="pfc-frame">
					<div className="pfc-chapter">
						<span className="pfc-chapter-no">02</span>
						<span className="pfc-chapter-name">The problem</span>
					</div>

					<div className="pfc-type" id="pfc-heading">
						<ProofHeading />
						<p className="pfc-lede">
							A confident sentence is not an answer. NOVA only speaks from documents it was allowed to open &mdash;
							and every answer carries a trace back to its source. Change a policy on Monday and the answer
							changes with it.
						</p>
						<ProofAnnotationStack onEnter={onEnter} />
					</div>

					<div className="pfc-instrument">
						<EvidenceTrace active={active} onFocus={setActive} phase={phase} />
					</div>

					<ProofAnnotationFloats />


				</div>
			</div>
		</section>
	)
}
