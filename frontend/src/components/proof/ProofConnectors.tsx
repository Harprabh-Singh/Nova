import type { CSSProperties } from "react"
import { proofSources, type ProofSourceId } from "../../data/proofEvidence.ts"

/**
 * Orbitals -> evidence traces.
 *
 * The hero's armillary rings are not faded out and replaced with a different
 * graphic. Each ring is the SAME <path>, and the shared scroll value flattens
 * it (scaleY -> ~0.04), stretches it (scaleX), untilts it, and then reveals the
 * straightened connector geometry underneath it by running its dash offset to
 * zero. Visually the orbit is pulled apart into a thin line that lands on the
 * ANSWER TRACE.
 */

const CX = 720
const CY = 675

function ellipsePath(rx: number, ry: number) {
	return `M ${CX - rx} ${CY} A ${rx} ${ry} 0 1 1 ${CX + rx} ${CY} A ${rx} ${ry} 0 1 1 ${CX - rx} ${CY}`
}

function connectorPath(x1: number, y1: number, x2: number, y2: number, bow: number) {
	const mx = (x1 + x2) / 2
	return `M ${x1} ${y1} C ${mx} ${y1 + bow} ${mx} ${y2 - bow} ${x2} ${y2}`
}

type Props = {
	active: ProofSourceId | null
}

export function ProofConnectors({ active }: Props) {
	return (
		<svg className="pfc-traces" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
			<defs>
				<linearGradient id="pfc-trace-fade" x1="0" y1="0" x2="1" y2="0">
					<stop offset="0%" stopColor="#c8ff3d" stopOpacity="0.05" />
					<stop offset="55%" stopColor="#c8ff3d" stopOpacity="0.5" />
					<stop offset="100%" stopColor="#c8ff3d" stopOpacity="0.9" />
				</linearGradient>
			</defs>

			{proofSources.map((source, index) => {
				const { rx, ry, tilt } = source.orbit
				const { x1, y1, x2, y2, bow } = source.connector
				const style = {
					"--orbit-tilt": `${tilt}deg`,
					"--trace-delay": `${index * 0.06}`,
				} as CSSProperties
				return (
					<g
						key={source.id}
						className={`pfc-trace-group${active === source.id ? " is-active" : ""}${active && active !== source.id ? " is-dimmed" : ""}`}
						style={style}
					>
						{/* the hero orbital, flattening */}
						<path className="pfc-orbit" d={ellipsePath(rx, ry)} />
						{/* the same line, now an evidence trace */}
						<path className="pfc-trace" d={connectorPath(x1, y1, x2, y2, bow)} stroke="url(#pfc-trace-fade)" />
						<circle className="pfc-trace-node" cx={x2} cy={y2} r={3} />
					</g>
				)
			})}

			{/* The dial that used to surround the knowledge core, reduced to a
			    single surveyed baseline along the trace panel. */}
			<line className="pfc-trace-baseline" x1="862" y1="300" x2="862" y2="580" />
		</svg>
	)
}
