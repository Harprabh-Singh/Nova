/**
 * The Proof Chamber environment.
 *
 * This is deliberately NOT a new background. It is the SAME architectural
 * photograph as the hero, cropped deeper into the room and graded down as the
 * shared scroll value --pf advances: the camera keeps moving through one
 * building instead of cutting to another set.
 *
 *   hero            proof chamber
 *   scale 1.00  ->  scale 1.06        (we push further in)
 *   y  50%      ->  y  38%            (the lens tilts toward the floor)
 *   grade 0.82  ->  grade 0.97        (the room falls away into editorial black)
 *   grid  0.35  ->  grid  1.00        (the survey grid takes over)
 */
export function ProofEnvironment() {
	return (
		<div className="pfc-env" aria-hidden="true">
			<div className="pfc-env-image" />
			<div className="pfc-env-grade" />
			<div className="pfc-env-vignette" />
			<div className="pfc-env-grid" />
			{/* The polished floor of the hero, continuing and darkening. */}
			<div className="pfc-env-floor" />
			{/* What is left of the knowledge core: a single lime status point. */}
			<div className="pfc-env-core">
				<span className="pfc-env-core-point" />
			</div>
			<div className="pfc-env-grain" />
		</div>
	)
}
