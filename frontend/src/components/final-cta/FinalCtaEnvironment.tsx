/* ============================================================================
   The threshold room. The same architecture asset as every other section,
   pushed deepest into shadow: the centre is left almost empty so the
   typography has a stage.

   Decorative only — all CSS, no 3D, no canvas.
   ========================================================================== */

export function FinalCtaEnvironment() {
	return (
		<div className="fct-env" aria-hidden="true">
			<div className="fct-env-image" />
			<div className="fct-env-grade" />
			{/* soft daylight entering through a high opening, behind the words */}
			<div className="fct-env-opening" />
			<div className="fct-env-mist" />
			{/* the two dark walls that frame the centre */}
			<div className="fct-env-wall left" />
			<div className="fct-env-wall right" />
			<div className="fct-env-grid" />
			<div className="fct-env-floor" />
			<div className="fct-env-vignette" />
			<div className="fct-env-grain" />
		</div>
	)
}
