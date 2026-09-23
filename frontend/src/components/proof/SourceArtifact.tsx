import type { CSSProperties } from "react"
import type { ProofSource, ProofSourceId } from "../../data/proofEvidence.ts"

/**
 * A knowledge artifact, mid-journey.
 *
 * Same paper treatment as the hero artifact (thin border, tooth, metadata,
 * slight rotation) -- deliberately so: this IS the hero's document, continuing.
 * Its position is not two keyframes cross-fading, it is a live interpolation
 * between the hero coordinate and the proof coordinate driven by --pf.
 *
 * Flat 2D only: rotation, shadow, blur. No 3D, no WebGL.
 */

type Props = {
	source: ProofSource
	active: ProofSourceId | null
	onFocus: (id: ProofSourceId | null) => void
}

export function SourceArtifact({ source, active, onFocus }: Props) {
	const isActive = active === source.id
	const style = {
		"--fx": source.from.x,
		"--fy": source.from.y,
		"--fr": source.from.rotate,
		"--fs": source.from.scale,
		"--tx": source.to.x,
		"--ty": source.to.y,
		"--tr": source.to.rotate,
		"--ts": source.to.scale,
	} as CSSProperties

	return (
		<button
			type="button"
			className={`pfc-doc${source.arrives ? " is-arriving" : ""}${isActive ? " is-active" : ""}${
				active && !isActive ? " is-dimmed" : ""
			}`}
			style={style}
			aria-pressed={isActive}
			aria-label={`${source.title}, ${source.department}, ${source.version}. Highlight its retrieval row and citation.`}
			onMouseEnter={() => onFocus(source.id)}
			onMouseLeave={() => onFocus(null)}
			onFocus={() => onFocus(source.id)}
			onBlur={() => onFocus(null)}
			onClick={() => onFocus(isActive ? null : source.id)}
		>
			<span className="pfc-doc-head">
				<span className="pfc-doc-kind">{source.kind}</span>
				<span className="pfc-doc-state">{source.state}</span>
			</span>
			<span className="pfc-doc-title">{source.title}</span>
			<span className="pfc-doc-rules" aria-hidden="true" />
			<span className="pfc-doc-meta">
				{source.department} &middot; {source.version}
			</span>
			<span className="pfc-doc-ref" aria-hidden="true">
				[{source.ref}]
			</span>
		</button>
	)
}

/**
 * Artifacts that do not become evidence for this question. They stay in the
 * room -- drifting further back, losing contrast -- so the environment never
 * looks emptied out between the two sections.
 */
export function AmbientArtifact({
	title,
	meta,
	from,
	to,
}: {
	title: string
	meta: string
	from: { x: number; y: number }
	to: { x: number; y: number }
}) {
	const style = {
		"--fx": from.x,
		"--fy": from.y,
		"--tx": to.x,
		"--ty": to.y,
	} as CSSProperties
	return (
		<div className="pfc-doc pfc-doc-ambient" style={style} aria-hidden="true">
			<span className="pfc-doc-title">{title}</span>
			<span className="pfc-doc-meta">{meta}</span>
		</div>
	)
}
