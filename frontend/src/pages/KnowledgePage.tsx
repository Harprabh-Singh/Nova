import { useEffect, useMemo, useState } from "react"
import { ConsoleShell, Stat, Stamp } from "../components/console/ConsoleShell.tsx"
import { useRouter } from "../hooks/useRouter.tsx"
import { api } from "../services/api.ts"
import { useSession } from "../providers/SessionProvider.tsx"
import type { KnowledgeDocument } from "../types/index.ts"
import { timeAgo } from "../utils/format.ts"
import { stagger } from "../lib/motion.tsx"
import { useCountInt, useDragPan, useLitRows, useRevealGroup, useWipe } from "../lib/console-motion.tsx"
import "../styles/console.css"

export function KnowledgePage() {
	const { me } = useSession()
	const { navigate } = useRouter()
	const [documents, setDocuments] = useState<KnowledgeDocument[]>([])
	const [stats, setStats] = useState<Record<string, any> | null>(null)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [search, setSearch] = useState("")
	const [department, setDepartment] = useState("all")
	const [open, setOpen] = useState<string | null>(null)

	useEffect(() => {
		api
			.knowledge()
			.then((response) => {
				setDocuments(response.documents)
				setStats(response.stats as Record<string, any>)
			})
			.catch((caught) =>
				setError(caught instanceof Error ? caught.message : "Could not load the knowledge library."),
			)
			.finally(() => setLoading(false))
	}, [])

	const departments = useMemo(() => {
		const set = new Set(documents.map((document) => document.department))
		return ["all", ...Array.from(set)]
	}, [documents])

	const visible = useMemo(() => {
		const term = search.trim().toLowerCase()
		return documents.filter((document) => {
			const matchesDepartment = department === "all" || document.department === department
			const matchesTerm =
				!term ||
				document.title.toLowerCase().includes(term) ||
				document.filename.toLowerCase().includes(term) ||
				document.category.toLowerCase().includes(term)
			return matchesDepartment && matchesTerm
		})
	}, [documents, search, department])

	const reveal = useRevealGroup<HTMLDivElement>(`${department}:${search}:${visible.length}`)
	const lit = useLitRows<HTMLDivElement>(visible.length)
	const pan = useDragPan<HTMLDivElement>()

	const visibleCount = useCountInt(visible.length)
	const activeCount = useCountInt(Number(stats?.activeDocuments ?? 0))
	const versionCount = useCountInt(Number(stats?.versions ?? 0))
	const chunkCount = useCountInt(Number(stats?.chunks ?? 0))

	const record = visible.find((document) => document.id === open) ?? null
	const wipe = useWipe(open)

	return (
		<ConsoleShell
			eyebrow="02 / Library"
			title="Everything you are"
			titleTail="cleared to read."
			lede="This shelf is already filtered by your role and department. If a document is not here, it was never eligible to reach the model on your behalf."
			actions={
				me?.scope.canUploadKnowledge || me?.scope.isAdmin ? (
					<button className="wx-btn solid" type="button" onClick={() => navigate("/knowledge/upload")}>
						Upload a document
					</button>
				) : null
			}
		>
			{error ? <div className="wx-alert">{error}</div> : null}

			<div className="wx-col" ref={reveal}>
				<div className="wx-grid c4">
					<Stat label="Visible to you" value={visibleCount} hint="after permission filtering" fill={0.8} />
					<Stat label="Active documents" value={activeCount} hint="live for retrieval" fill={0.6} tone="cyan" delay={0.05} />
					<Stat label="Versions" value={versionCount} hint="including superseded" fill={0.45} tone="violet" delay={0.1} />
					<Stat label="Indexed chunks" value={chunkCount} hint="retrievable passages" fill={0.7} delay={0.15} />
				</div>

				<div className="wx-rule">Filter</div>

				<input
					className="wx-search"
					value={search}
					onChange={(event) => setSearch(event.target.value)}
					placeholder="Search by title, filename or category"
				/>

				<div className="wx-pills cm-pan" ref={pan}>
					{departments.map((value) => (
						<button
							type="button"
							key={value}
							className={`wx-pill ${department === value ? "on" : ""}`}
							onClick={() => setDepartment(value)}
						>
							{value === "all" ? "all departments" : value}
						</button>
					))}
				</div>

				<div className="wx-rule">The shelf</div>

				{loading ? (
					<div className="wx-col">
						{[0, 1, 2, 3, 4].map((index) => (
							<div className="wx-skel" key={index} />
						))}
					</div>
				) : (
					<div className="wx-ledger" ref={lit}>
						<div className="wx-ledger-head">
							<span>Document</span>
							<span>Department</span>
							<span>Class</span>
							<span>Category</span>
							<span>Updated</span>
						</div>
						{visible.map((document) => (
							<div
								className={`wx-ledger-row cm-lit${open === document.id ? " is-open" : ""}`}
								key={document.id}
								data-reveal
								data-lit
								onClick={() => setOpen(open === document.id ? null : document.id)}
							>
								<span className="t">
									{document.title}
									<em className="f">{document.filename}</em>
								</span>
								<span className="wx-cell-mono">{document.department}</span>
								<span>
									<Stamp kind={document.classification}>{document.classification}</Stamp>
								</span>
								<span className="wx-cell-mono">{document.category}</span>
								<span className="wx-cell-mono">{timeAgo(document.updatedAt)}</span>
							</div>
						))}
						{visible.length === 0 ? <div className="wx-empty">No documents match this filter</div> : null}
					</div>
				)}
			</div>

			{record ? (
				<div className="wx-drawer" key={wipe.key}>
					<div className={`wx-drawer-top ${wipe.className}`}>
						<div>
							<h3>{record.title}</h3>
							<p className="wx-cell-mono">
								{record.filename} &middot; {record.sourceType}
							</p>
						</div>
						<button className="wx-close" type="button" onClick={() => setOpen(null)}>
							Close
						</button>
					</div>

					<div className="wx-drawer-body">
						<div className="wx-grid c3">
							<div className="wx-slab">
								<div className="wx-label">Department</div>
								<p className="wx-cell-mono">{record.department}</p>
							</div>
							<div className="wx-slab">
								<div className="wx-label">Classification</div>
								<p>
									<Stamp kind={record.classification}>{record.classification}</Stamp>
								</p>
							</div>
							<div className="wx-slab">
								<div className="wx-label">Allowed roles</div>
								<p className="wx-cell-mono">
									{record.allowedRoles.length ? record.allowedRoles.join(", ") : "every role cleared for this class"}
								</p>
							</div>
						</div>

						<div className="wx-rule">Version history</div>
						<div className="wx-timeline">
							{record.versions.map((version, index) => {
								const entrance = stagger(index)
								return (
									<div
										className={`wx-tl ${version.status === "active" ? "is-active" : ""} ${entrance.className}`}
										style={entrance.style}
										key={version.id}
									>
										<i className="node" />
										<div>
											<div className="v">v{version.version}</div>
											<div className="m">
												{version.chunkCount} chunks &middot; effective {version.effectiveDate || "n/a"} &middot; uploaded{" "}
												{timeAgo(version.uploadedAt)} by {version.uploadedBy || "unknown"}
											</div>
										</div>
										<Stamp kind={version.status === "active" ? "ok" : "warn"}>{version.status}</Stamp>
									</div>
								)
							})}
						</div>
					</div>
				</div>
			) : null}
		</ConsoleShell>
	)
}

export default KnowledgePage
