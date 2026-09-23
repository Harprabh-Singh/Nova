/**
 * The Knowledge Core: a physical-looking mineral object, built entirely from
 * radial gradients, box-shadows and SVG. No raster, no generic AI orb.
 */
export function KnowledgeCore() {
	return (
		<div className="nvh-core" aria-hidden="true">
			<div className="nvh-core-shadow" />
			<div className="nvh-core-glow" />
			<div className="nvh-core-surface">
				<span className="nvh-core-facet" />
				<span className="nvh-core-seam" />
			</div>
			<svg className="nvh-core-rings" viewBox="0 0 400 400">
				<ellipse className="nvh-core-ring r1" cx="200" cy="200" rx="150" ry="44" />
				<ellipse className="nvh-core-ring r2" cx="200" cy="200" rx="186" ry="62" />
			</svg>
		</div>
	)
}
