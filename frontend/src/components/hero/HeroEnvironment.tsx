/**
 * The architectural environment: the only raster layer in the hero.
 *
 * Everything above it (grade, vignette, grid, floor light, grain) is CSS, so
 * the photograph stays a photograph and never carries typography or UI.
 */
export function HeroEnvironment() {
	return (
		<div className="nvh-env" aria-hidden="true">
			<div className="nvh-env-image" />
			<div className="nvh-env-grade" />
			<div className="nvh-env-vignette" />
			<div className="nvh-env-grid" />
			<div className="nvh-env-floor" />
			<div className="nvh-env-grain" />
		</div>
	)
}
