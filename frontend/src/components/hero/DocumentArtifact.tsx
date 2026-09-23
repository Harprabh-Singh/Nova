import type { CSSProperties } from "react"
import type { HeroDocument } from "../../data/heroDocuments.ts"

/**
 * A single knowledge artifact: physical, paper-like, thin-bordered. Rendered
 * from data so the real document service can feed it later.
 */
export function DocumentArtifact({ doc }: { doc: HeroDocument }) {
	return (
		<article
			className={`nvh-doc slot-${doc.slot} depth-${doc.depth}${doc.cited ? " is-cited" : ""}`}
			style={
				{
					"--doc-rotation": `${doc.rotation}deg`,
					"--doc-drift": `${doc.drift}s`,
				} as CSSProperties
			}
		>
			<header className="nvh-doc-head">
				<span className="nvh-doc-type">{doc.type}</span>
				<span className="nvh-doc-state">{doc.state}</span>
			</header>
			<h2 className="nvh-doc-title">{doc.title}</h2>
			<span className="nvh-doc-rules" aria-hidden="true" />
			<footer className="nvh-doc-meta">
				{doc.department} · V{doc.version}
			</footer>
		</article>
	)
}
