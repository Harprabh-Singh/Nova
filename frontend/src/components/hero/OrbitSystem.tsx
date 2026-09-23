/** One orbital ring. Rings are static; the markers travel along them. */
type OrbitRing = {
	id: string
	rx: number
	ry: number
	tilt: number
	tone: "lime" | "bone" | "violet"
	/** Seconds for a marker to complete one full traversal. */
	duration: number
	reverse?: boolean
	dashed?: boolean
	/** Starting positions of the markers, as a percentage along the path. */
	markers: number[]
	radius: number
}

const CX = 720
/* Centre of the composition. The orbit centre, the knowledge core and the
   demo portal all resolve to the same axis, so the group reads centred in the
   frame rather than sitting low and off to one side. */
const CY = 675

/** Ellipse expressed as a path, so markers can ride it via offset-path. */
function ellipsePath(rx: number, ry: number) {
	return `M ${CX - rx} ${CY} A ${rx} ${ry} 0 1 1 ${CX + rx} ${CY} A ${rx} ${ry} 0 1 1 ${CX - rx} ${CY}`
}

const RINGS: OrbitRing[] = [
	{ id: "r1", rx: 196, ry: 54, tilt: -16, tone: "lime", duration: 15, markers: [0, 52], radius: 3.4 },
	{ id: "r2", rx: 254, ry: 94, tilt: 24, tone: "bone", duration: 23, reverse: true, markers: [18], radius: 2.8 },
]

/**
 * The orbital system reads as an armillary instrument around the Knowledge
 * Core: the rings themselves hold still, and motion comes from markers
 * travelling along the paths plus slow dash flow on the outer rings.
 */
export function OrbitSystem() {
	return (
		<svg className="nvh-orbits" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
			<g className="nvh-orbit-system">
				{RINGS.map((ring) => (
					<g key={ring.id} transform={`rotate(${ring.tilt} ${CX} ${CY})`}>
						<ellipse
							className={`nvh-orbit ${ring.tone}${ring.dashed ? " is-dashed" : ""}`}
							cx={CX}
							cy={CY}
							rx={ring.rx}
							ry={ring.ry}
						/>
						{ring.markers.map((start, index) => (
							<circle
								key={`${ring.id}-${index}`}
								className={`nvh-orbit-node ${ring.tone}`}
								r={ring.radius}
								style={{
									offsetPath: `path("${ellipsePath(ring.rx, ring.ry)}")`,
									animationDuration: `${ring.duration}s`,
									animationDirection: ring.reverse ? "reverse" : "normal",
									animationDelay: `-${(ring.duration * start) / 100}s`,
								}}
							/>
						))}
					</g>
				))}
			</g>
		</svg>
	)
}
