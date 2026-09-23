/* ============================================================================
   THE ACCESS CHAMBER — environment.

   One room, not a backdrop. The NOVA architectural photograph supplies the
   concrete, the glass bays, the planting, the atrium opening and the wet
   stone floor; CSS only grades it, adds structural mass where type and the
   terminal land, and lifts the daylight falling through the central shaft.

   The shaft is the point: it is what physically connects the statement on
   the left to the terminal on the right. The middle of this page is never
   empty black.

   All 2D. No canvas, no WebGL, no 3D.
   ========================================================================== */

export function AccessEnvironment() {
	return (
		<>
			<div className="access-background" aria-hidden="true">
				<div className="env-photo" />
				<div className="env-tint" />
				<div className="env-mass" />

				{/* the central architectural opening */}
				<div className="env-threshold">
					<span className="shaft" />
					<span className="haze" />
					<span className="depth" />
				</div>

				{/* wet stone */}
				<div className="env-floor" />
				<div className="env-floor-sheen" />
			</div>

			<div className="access-vignette" aria-hidden="true" />
			<div className="access-grid" aria-hidden="true" />
			<div className="access-grain" aria-hidden="true" />
		</>
	)
}
