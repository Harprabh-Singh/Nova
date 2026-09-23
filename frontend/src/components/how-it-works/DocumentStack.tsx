/**
 * CHAPTER 01 interior — enterprise documents entering the system.
 *
 * Paper artifacts, not file-manager rows: thin border, tooth, version stamp,
 * slight rotation. Their index markers light up in sequence once the chapter
 * becomes active (CSS handles the stagger).
 */

const DOCS = [
	{ title: ["Employee", "Handbook"], meta: "PDF · V2.1" },
	{ title: ["Procurement", "Policy"], meta: "PDF · V2.2" },
	{ title: ["Engineering", "SOP"], meta: "DOCX · V3.0" },
]

export function DocumentStack() {
	return (
		<div className="hiw-docs" aria-hidden="true">
			{DOCS.map((doc, i) => (
				<div className="hiw-doc" key={doc.meta} style={{ "--i": i } as React.CSSProperties}>
					<span className="hiw-doc-mark" />
					<span className="hiw-doc-title">
						{doc.title[0]}
						<br />
						{doc.title[1]}
					</span>
					<span className="hiw-doc-rules" />
					<span className="hiw-doc-meta">{doc.meta}</span>
				</div>
			))}
			<span className="hiw-docs-rail" />
		</div>
	)
}
