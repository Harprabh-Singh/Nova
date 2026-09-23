import { useRef, useState } from "react"
import { ConsoleShell, Stamp } from "../components/console/ConsoleShell.tsx"
import { api } from "../services/api.ts"
import { useSession } from "../providers/SessionProvider.tsx"
import { stagger, usePipelineStage } from "../lib/motion.tsx"
import { useLogPrinter, usePressBloom, useRevealGroup } from "../lib/console-motion.tsx"
import "../styles/console.css"

const CATEGORIES = ["policy", "sop", "handbook", "standard", "plan", "matrix", "guideline", "other"]
const CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"]

const STAGES: Array<[string, string]> = [
	["VALIDATE", "type, size and encoding"],
	["EXTRACT", "text out of the container"],
	["DETECT", "department, version, effective date"],
	["CHUNK", "split on section boundaries"],
	["EMBED", "vectors for each chunk"],
	["INDEX", "write to the searchable store"],
	["SEARCHABLE", "live for authorised roles"],
]

const LOG_LINES = [
	"reading container bytes",
	"stripping layout, keeping headings",
	"scanning for injected instructions",
	"splitting on section boundaries",
	"embedding passages",
	"writing index entries",
	"publishing to authorised roles",
]

const HOUSE_RULES: Array<[string, string]> = [
	["Classification", "decides who may retrieve it"],
	["Version", "supersedes, it does not overwrite"],
	["Effective date", "lets the assistant prefer current policy"],
	["Allowed roles", "narrows further than classification"],
]

function formatSize(bytes: number) {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function UploadPage() {
	const { me } = useSession()
	const fileInput = useRef<HTMLInputElement | null>(null)
	const [files, setFiles] = useState<File[]>([])
	const [over, setOver] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [results, setResults] = useState<Array<Record<string, any>> | null>(null)
	const [message, setMessage] = useState<string | null>(null)

	const [department, setDepartment] = useState("")
	const [category, setCategory] = useState("policy")
	const [classification, setClassification] = useState("internal")
	const [version, setVersion] = useState("")
	const [effectiveDate, setEffectiveDate] = useState("")
	const [allowedRoles, setAllowedRoles] = useState("")
	const [activate, setActivate] = useState(true)

	const canUpload = Boolean(me?.scope.canUploadKnowledge || me?.scope.isAdmin)
	const stage = usePipelineStage(busy, STAGES.length, 520)
	const printed = useLogPrinter(busy, LOG_LINES, 520)
	const reveal = useRevealGroup<HTMLDivElement>(files.length)
	const bloom = usePressBloom()

	const accept = (incoming: FileList | null) => {
		if (!incoming) return
		setFiles(Array.from(incoming))
		setResults(null)
		setError(null)
	}

	const submit = async (event: React.FormEvent) => {
		event.preventDefault()
		if (!files.length) {
			setError("Choose at least one document first.")
			return
		}
		setBusy(true)
		setError(null)
		setResults(null)
		try {
			const form = new FormData()
			files.forEach((file) => form.append("files", file))
			if (department) form.append("department", department)
			form.append("category", category)
			form.append("classification", classification)
			if (version) form.append("version", version)
			if (effectiveDate) form.append("effectiveDate", effectiveDate)
			if (allowedRoles) form.append("allowedRoles", allowedRoles)
			form.append("activate", String(activate))

			const response = await api.upload(form)
			setResults(response.results)
			setMessage(response.message)
			setFiles([])
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Upload failed.")
		} finally {
			setBusy(false)
		}
	}

	return (
		<ConsoleShell
			eyebrow="03 / Intake"
			title="Feed the"
			titleTail="machine."
			lede="Documents are extracted, screened for injected instructions, chunked on section boundaries, embedded and then published to the roles you allow. Nothing becomes answerable until that finishes."
		>
			{!canUpload ? (
				<div className="wx-alert info">Your role cannot upload knowledge. Switch to an admin persona to try this.</div>
			) : null}
			{error ? <div className="wx-alert">{error}</div> : null}

			<div className="wx-grid c2" style={{ alignItems: "start" }}>
				<form className="wx-col" onSubmit={submit}>
					<div
						className={`wx-drop ${over ? "is-over" : ""}`}
						onClick={() => fileInput.current?.click()}
						onDragOver={(event) => {
							event.preventDefault()
							setOver(true)
						}}
						onDragLeave={() => setOver(false)}
						onDrop={(event) => {
							event.preventDefault()
							setOver(false)
							accept(event.dataTransfer.files)
						}}
					>
						<span className="corner tl" />
						<span className="corner tr" />
						<span className="corner bl" />
						<span className="corner br" />
						<strong style={{ fontFamily: "var(--wx-display)", fontSize: 18 }}>Drop documents here</strong>
						<div className="hint">PDF, DOCX, TXT or Markdown &middot; or click to browse</div>
						{busy ? (
							<span className="wx-scan">
								<i />
							</span>
						) : null}
						<input
							ref={fileInput}
							type="file"
							multiple
							accept=".pdf,.docx,.txt,.md,.markdown"
							style={{ display: "none" }}
							onChange={(event) => accept(event.target.files)}
						/>
					</div>

					{files.length ? (
						<div className="wx-col" ref={reveal} style={{ gap: 8 }}>
							{files.map((file, index) => {
								const entrance = stagger(index)
								return (
									<div className={`wx-file ${entrance.className}`} style={entrance.style} key={file.name}>
										<span className="n">{String(index + 1).padStart(2, "0")}</span>
										<span className="nm">{file.name}</span>
										<span className="sz">{formatSize(file.size)}</span>
									</div>
								)
							})}
						</div>
					) : null}

					<div className="wx-rule">Labelling</div>

					<div className="wx-grid c2">
						<label className="wx-field">
							<span>Department</span>
							<select value={department} onChange={(event) => setDepartment(event.target.value)}>
								<option value="">Detect from document</option>
								{(me?.tenant.departments ?? []).map((value: string) => (
									<option value={value} key={value}>
										{value}
									</option>
								))}
							</select>
						</label>
						<label className="wx-field">
							<span>Category</span>
							<select value={category} onChange={(event) => setCategory(event.target.value)}>
								{CATEGORIES.map((value) => (
									<option value={value} key={value}>
										{value}
									</option>
								))}
							</select>
						</label>
						<label className="wx-field">
							<span>Classification</span>
							<select value={classification} onChange={(event) => setClassification(event.target.value)}>
								{CLASSIFICATIONS.map((value) => (
									<option value={value} key={value}>
										{value}
									</option>
								))}
							</select>
						</label>
						<label className="wx-field">
							<span>Version</span>
							<input value={version} onChange={(event) => setVersion(event.target.value)} placeholder="e.g. 2026.2" />
						</label>
						<label className="wx-field">
							<span>Effective date</span>
							<input type="date" value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)} />
						</label>
						<label className="wx-field">
							<span>Allowed roles</span>
							<input
								value={allowedRoles}
								onChange={(event) => setAllowedRoles(event.target.value)}
								placeholder="HR_MANAGER, ADMIN"
							/>
						</label>
					</div>

					<button type="button" className={`wx-toggle ${activate ? "on" : ""}`} onClick={() => setActivate(!activate)}>
						<span className="box" />
						Activate immediately &mdash; supersedes the previous active version
					</button>

					<button
						className={`wx-btn solid ${bloom.className}`}
						onPointerDown={bloom.onPointerDown}
						type="submit"
						disabled={busy || !canUpload}
					>
						{busy ? "Building knowledge base\u2026" : "Build knowledge base"}
					</button>
				</form>

				<div className="wx-col" style={{ position: "sticky", top: 0 }}>
					<div className="wx-slab pad-lg">
						<div className="wx-slab-head">
							<h3>Ingestion pipeline</h3>
							<span className="wx-chip acid">
								{busy ? `0${Math.min(STAGES.length, stage + 1)} / ${STAGES.length}` : "idle"}
							</span>
						</div>

						<div className="wx-bar">
							<i
								style={
									{
										["--fill" as string]: String(busy ? (stage + 1) / STAGES.length : results ? 1 : 0),
									} as React.CSSProperties
								}
							/>
						</div>

						<div className="wx-pipe">
							{STAGES.map(([name, detail], index) => (
								<div
									className={`wx-pipe-line ${busy && index === stage ? "is-now" : ""} ${
										(busy && index < stage) || (!busy && results) ? "is-past" : ""
									}`}
									key={name}
								>
									<span className="ix">{String(index + 1).padStart(2, "0")}</span>
									<span className="st">
										{name}
										<em>{detail}</em>
									</span>
								</div>
							))}
						</div>

						{busy ? (
							<div className="wx-col" style={{ gap: 4 }}>
								{LOG_LINES.slice(0, printed).map((line) => (
									<div className="wx-cell-mono cm-print" key={line}>
										&gt; {line}
									</div>
								))}
							</div>
						) : null}
					</div>

					<div className="wx-slab pad-lg">
						<div className="wx-slab-head">
							<h3>House rules</h3>
						</div>
						<div>
							{HOUSE_RULES.map(([name, detail]) => (
								<div className="wx-matrix-row" key={name}>
									<span className="d">{name}</span>
									<span className="wx-cell-mono">{detail}</span>
								</div>
							))}
						</div>
					</div>
				</div>
			</div>

			{results ? (
				<>
					<div className="wx-rule">Intake receipt</div>
					<div className="wx-col">
						<div className="wx-receipt">
							<span>{message ?? "Knowledge base updated."}</span>
							<span className="x">{results.length} FILE(S)</span>
						</div>
						{results.map((result, index) => {
							const entrance = stagger(index)
							const warnings: string[] = result.warnings ?? []
							return (
								<div
									className={`wx-slab pad-lg ${entrance.className}`}
									style={entrance.style}
									key={result.filename ?? index}
								>
									<div className="wx-slab-head">
										<h3>{result.title ?? result.filename}</h3>
										<Stamp kind={result.error ? "deny" : "ok"}>{result.error ? "rejected" : "indexed"}</Stamp>
									</div>
									<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
										{result.department ? <span className="wx-chip">{result.department}</span> : null}
										{result.version ? <span className="wx-chip">v{result.version}</span> : null}
										{result.chunkCount ? <span className="wx-chip cyan">{result.chunkCount} chunks</span> : null}
										{result.injectionPatternsRemoved ? (
											<span className="wx-chip magenta">
												{result.injectionPatternsRemoved} injection patterns neutralised
											</span>
										) : null}
									</div>
									{warnings.length ? <div className="wx-cell-mono">{warnings.join(" \u00b7 ")}</div> : null}
									{result.error ? <div className="wx-cell-mono">{String(result.error)}</div> : null}
								</div>
							)
						})}
					</div>
				</>
			) : null}
		</ConsoleShell>
	)
}

export default UploadPage
