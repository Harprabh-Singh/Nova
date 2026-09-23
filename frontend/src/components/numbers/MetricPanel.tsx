import type { Metric } from "../../data/metrics.ts"
import { EvidenceTraceDiagram } from "./EvidenceTraceDiagram.tsx"
import { DataIsolationDiagram } from "./DataIsolationDiagram.tsx"
import { ClassificationDiagram } from "./ClassificationDiagram.tsx"
import { ActionDiagram } from "./ActionDiagram.tsx"

/* ============================================================================
   One evidence bay. Number, title, value, one sentence, one diagram, one rule
   of metadata. The bays share hairline dividers so the four read as a single
   wall rather than four cards.
   ========================================================================== */

const DIAGRAMS = {
	evidence: EvidenceTraceDiagram,
	privacy: DataIsolationDiagram,
	access: ClassificationDiagram,
	action: ActionDiagram,
}

export function MetricPanel({ metric, index }: { metric: Metric; index: number }) {
	const Diagram = DIAGRAMS[metric.diagram]

	return (
		<article
			className={"nbr-bay" + (metric.lit ? " is-lit" : "")}
			data-bay={metric.diagram}
			tabIndex={0}
			style={{ "--i": index } as React.CSSProperties}
		>
			<header className="nbr-bay-head">
				<span className="nbr-bay-no">{metric.id}</span>
				<span className="nbr-bay-eyebrow">{metric.eyebrow}</span>
			</header>

			{/* The value is the loudest thing in the bay — every one of them is
			    checked against the implementation, see data/metrics.ts. */}
			<p className="nbr-value">{metric.value}</p>
			<p className="nbr-value-label">{metric.label}</p>

			<h3 className="nbr-bay-title">
				<span>{metric.title[0]}</span>
				<span>{metric.title[1]}</span>
			</h3>

			<p className="nbr-bay-copy">{metric.description}</p>

			<div className="nbr-bay-dia">
				<Diagram />
			</div>

			<footer className="nbr-bay-meta">{metric.metadata}</footer>
		</article>
	)
}
