/**
 * The room, continuing.
 *
 * This is the SAME architectural photograph used by the hero and the proof
 * chamber, pushed further into the building and graded down. Every layer above
 * the photograph is CSS: grade, vignette, survey grid, floor light, the accent
 * pool that follows the active chapter, and grain.
 *
 * Layers move at different rates against --hw-p (the section's horizontal
 * progress), which is what makes the flat composition read as depth:
 *
 *   cards        100%
 *   interiors    ~110%
 *   background    12%
 *   overlays       6%
 *   grain        static
 */
export function WorkflowEnvironment() {
	return (
		<div className="hiw-env" aria-hidden="true">
			<div className="hiw-env-image" />
			<div className="hiw-env-grade" />
			<div className="hiw-env-columns" />
			<div className="hiw-env-grid" />
			<div className="hiw-env-floor" />
			<div className="hiw-env-accent" />
			<div className="hiw-env-vignette" />
			<div className="hiw-env-grain" />
		</div>
	)
}
