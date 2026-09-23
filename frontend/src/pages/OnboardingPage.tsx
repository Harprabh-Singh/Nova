import { useMemo, useRef, useState, type ReactNode } from "react"
import { api, setToken } from "../services/api.ts"
import { useSession } from "../providers/SessionProvider.tsx"
import { useRouter } from "../hooks/useRouter.tsx"
import { Rise, useCharReveal, useTilt } from "../lib/anim.tsx"
import "../anim.css"
import "../styles/onboarding.css"

const INDUSTRIES = [
	"Manufacturing",
	"Healthcare",
	"Financial Services",
	"Retail",
	"Information Technology",
	"Education",
	"Logistics",
	"Professional Services",
]

const CATEGORY_OPTIONS = ["HR", "Finance", "Engineering", "Operations", "Safety", "Security", "Other"]
const CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"]

const STEPS = [
	{ no: "01", label: "Organisation", sub: "Who the knowledge belongs to", accent: "" },
	{ no: "02", label: "Knowledge", sub: "Documents and access rules", accent: "accent-cyan" },
	{ no: "03", label: "Build", sub: "Review and index", accent: "accent-magenta" },
] as const

const bytes = (size: number) => (size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`)

const extension = (fileName: string) => {
	const dot = fileName.lastIndexOf(".")
	return dot > -1 ? fileName.slice(dot + 1).toUpperCase() : "FILE"
}

/** Small labelled control, styled for the bone panel. */
function Line({ label, hint, span, children }: { label: string; hint?: string; span?: boolean; children: ReactNode }) {
	return (
		<div className={`obx-field${span ? " obx-span-2" : ""}`}>
			<label>{label}</label>
			{children}
			{hint ? <span className="hint">{hint}</span> : null}
		</div>
	)
}

/**
 * Self-serve tenant creation: organisation -> documents and access -> review and
 * build. Three panels instead of one long form, in the home page's visual
 * language. Nothing here is NovaTech specific, and no step invents numbers.
 */
export function OnboardingPage() {
	const { health, refresh } = useSession()
	const { navigate } = useRouter()

	const [step, setStep] = useState(0)
	const [name, setName] = useState("")
	const [industry, setIndustry] = useState<string>(INDUSTRIES[0])
	const [adminName, setAdminName] = useState("")
	const [adminEmail, setAdminEmail] = useState("")
	const [category, setCategory] = useState("HR")
	const [department, setDepartment] = useState("")
	const [classification, setClassification] = useState("internal")
	const [allowedRoles, setAllowedRoles] = useState("")
	const [files, setFiles] = useState<File[]>([])
	const [dragOver, setDragOver] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [done, setDone] = useState<{ tenant: string; documents: number } | null>(null)

	const title = useRef<HTMLHeadingElement>(null)
	useCharReveal(title, { delay: 0.06, stagger: 0.016 })
	const tilt = useTilt({ max: 4, scale: 1 })

	// The mode badge must reflect what the backend actually verified.
	const mode = !health ? "Connecting" : health.isFullyLocal || !health.azureConfigured ? "Local demo mode" : "Hosted demo"

	const named = name.trim().length > 0
	const totalBytes = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files])

	const addFiles = (incoming: FileList | null) => {
		if (!incoming || incoming.length === 0) return
		const next = Array.from(incoming)
		setFiles((current) => {
			// De-duplicate by name + size so dropping twice does not double-upload.
			const seen = new Set(current.map((file) => `${file.name}:${file.size}`))
			return [...current, ...next.filter((file) => !seen.has(`${file.name}:${file.size}`))]
		})
	}

	const removeFile = (target: File) => setFiles((current) => current.filter((file) => file !== target))

	const goStep = (next: number) => {
		if (next > 0 && !named) {
			setError("A company name is required before continuing.")
			setStep(0)
			return
		}
		setError(null)
		setStep(Math.min(STEPS.length - 1, Math.max(0, next)))
	}

	const build = async () => {
		if (!named) {
			setError("A company name is required.")
			setStep(0)
			return
		}
		setBusy(true)
		setError(null)
		try {
			const created = await api.onboard({
				name,
				industry,
				adminName: adminName || `${name} Administrator`,
				adminEmail: adminEmail || undefined,
			})
			setToken(created.session.token)
			let documents = 0
			if (files.length > 0) {
				const form = new FormData()
				files.forEach((file) => form.append("files", file))
				form.append("category", category.toLowerCase())
				if (department) form.append("department", department)
				form.append("classification", classification)
				if (allowedRoles.trim()) form.append("allowedRoles", allowedRoles)
				form.append("activate", "true")
				const uploaded = await api.upload(form)
				documents = uploaded.results.filter((item) => !item.error).length
			}
			await refresh()
			setDone({ tenant: created.tenant.name, documents })
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Onboarding failed.")
		} finally {
			setBusy(false)
		}
	}

	return (
		<div className="obx">
			<div className="obx-grid" aria-hidden="true" />
			<div className="obx-glow" aria-hidden="true" />

			<div className="obx-shell">
				<header className="obx-top">
					<span className="obx-logo">
						<span className="mark" aria-hidden="true" /> NO<span className="b">V</span>
						<span className="c">A</span>
					</span>
					<div className="obx-top-right">
						<span className="obx-mode">
							<i aria-hidden="true" />
							{mode}
						</span>
						<button className="obx-exit" onClick={() => navigate("/")}>
							Exit <span className="an-underline" />
						</button>
					</div>
				</header>

				<div className="obx-head">
					<span className="obx-kicker">Onboarding</span>
					<h1 className="obx-title" ref={title}>
						Your knowledge. <span className="out">Your rules.</span>
					</h1>
					<p className="obx-lede">
						Create the organisation, bring the documents, set who may read them. NOVA chunks, embeds and versions
						everything you upload, then answers only from the material the asker is allowed to open.
					</p>
				</div>

				{done ? (
					<Rise className="obx-body" delay={0.05}>
						<div
							className="obx-done"
							style={{ gridColumn: "1 / -1" }}
							ref={tilt.ref}
							onMouseMove={tilt.onMouseMove}
							onMouseLeave={tilt.onMouseLeave}
						>
							<span className="stamp">Knowledge base ready</span>
							<h2>{done.tenant} is live.</h2>
							<p className="body">
								You are signed in as its administrator. Every answer from here on is grounded in the documents you
								indexed, cited back to the source, and filtered by the asker&rsquo;s clearance.
							</p>

							<div className="obx-tally">
								<div>
									<span className="k">Tenant</span>
									<div className="v">{done.tenant}</div>
								</div>
								<div>
									<span className="k">Documents indexed</span>
									<div className="v">{done.documents}</div>
								</div>
								<div>
									<span className="k">Default classification</span>
									<div className="v">{classification}</div>
								</div>
							</div>

							<div className="obx-actions">
								<button className="obx-btn" onClick={() => navigate("/chat")}>
									Ask a question <i aria-hidden="true">&rarr;</i>
								</button>
								<button className="obx-btn ghost" onClick={() => navigate("/knowledge/upload")}>
									Add more documents
								</button>
							</div>
						</div>
					</Rise>
				) : (
					<div className="obx-body">
						<nav className="obx-rail" aria-label="Onboarding steps">
							{STEPS.map((item, index) => (
								<button
									key={item.no}
									className={`obx-rail-step${index === step ? " is-active" : ""}${index < step ? " is-done" : ""}`}
									onClick={() => goStep(index)}
									disabled={busy || (index > 0 && !named)}
									aria-current={index === step ? "step" : undefined}
								>
									<span className="no">{item.no}</span>
									<span className="label">
										{item.label}
										<span className="sub">{item.sub}</span>
									</span>
								</button>
							))}

							<div className="obx-rail-meta">
								Organisation / <b>{named ? name : "unnamed"}</b>
								<br />
								Queued / <b>{files.length} file(s)</b>
								<br />
								Access / <b>{classification}</b>
							</div>
						</nav>

						{/* Keyed so each step re-mounts and replays its entrance. */}
						<Rise key={step} className={`obx-panel ${STEPS[step].accent}`} delay={0.04}>
							<div className="obx-panel-head">
								<h2>{STEPS[step].label}</h2>
								<span className="count">
									Step {step + 1} / {STEPS.length}
								</span>
							</div>

							{step === 0 ? (
								<div className="obx-fields">
									<Line label="Company name" hint="Becomes the tenant every document and answer is scoped to.">
										<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Logistics" autoFocus />
									</Line>
									<Line label="Industry">
										<select value={industry} onChange={(e) => setIndustry(e.target.value)}>
											{INDUSTRIES.map((option) => (
												<option key={option} value={option}>
													{option}
												</option>
											))}
										</select>
									</Line>
									<Line label="Administrator name" hint="Left blank, we name it after the company.">
										<input value={adminName} onChange={(e) => setAdminName(e.target.value)} placeholder="Jordan Blake" />
									</Line>
									<Line label="Administrator email" hint="Optional in demo mode.">
										<input value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="admin@acme.example" />
									</Line>
								</div>
							) : null}

							{step === 1 ? (
								<>
									<div
										className={`obx-drop${dragOver ? " is-over" : ""}`}
										onDragOver={(e) => {
											e.preventDefault()
											setDragOver(true)
										}}
										onDragLeave={() => setDragOver(false)}
										onDrop={(e) => {
											e.preventDefault()
											setDragOver(false)
											addFiles(e.dataTransfer?.files ?? null)
										}}
									>
										<span className="big">Drop your policies, SOPs and handbooks</span>
										<span className="small">PDF &middot; DOCX &middot; TXT &middot; MD &mdash; or click to browse</span>
										<input
											type="file"
											multiple
											accept=".pdf,.docx,.txt,.md,.markdown"
											aria-label="Upload your knowledge"
											onChange={(e) => {
												addFiles(e.target.files)
												e.target.value = ""
											}}
										/>
									</div>

									{files.length > 0 ? (
										<ul className="obx-files">
											{files.map((file) => (
												<li className="obx-file" key={`${file.name}:${file.size}`}>
													<span className="nm">{file.name}</span>
													<span className="sz">{bytes(file.size)}</span>
													<span className="tag">{extension(file.name)}</span>
													<button
														className="obx-exit"
														style={{ color: "rgba(10,11,15,.55)" }}
														onClick={() => removeFile(file)}
														aria-label={`Remove ${file.name}`}
													>
														Remove
													</button>
												</li>
											))}
										</ul>
									) : null}

									<div className="obx-fields three" style={{ marginTop: 26 }}>
										<Line label="Document category">
											<select value={category} onChange={(e) => setCategory(e.target.value)}>
												{CATEGORY_OPTIONS.map((option) => (
													<option key={option} value={option}>
														{option}
													</option>
												))}
											</select>
										</Line>
										<Line label="Department">
											<input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="Operations" />
										</Line>
										<Line label="Classification">
											<select value={classification} onChange={(e) => setClassification(e.target.value)}>
												{CLASSIFICATIONS.map((option) => (
													<option key={option} value={option}>
														{option}
													</option>
												))}
											</select>
										</Line>
									</div>

									<div className="obx-fields one">
										<Line
											label="Allowed roles (optional)"
											hint="Comma separated. Left blank, the classification alone decides who can retrieve these documents."
										>
											<input value={allowedRoles} onChange={(e) => setAllowedRoles(e.target.value)} placeholder="ADMIN, MANAGER" />
										</Line>
									</div>
								</>
							) : null}

							{step === 2 ? (
								<>
									<div className="obx-review">
										<div>
											<span className="k">Company</span>
											<div className="v">{named ? name : "\u2014"}</div>
										</div>
										<div>
											<span className="k">Industry</span>
											<div className="v">{industry}</div>
										</div>
										<div>
											<span className="k">Administrator</span>
											<div className="v">{adminName || `${name || "Company"} Administrator`}</div>
										</div>
										<div>
											<span className="k">Documents queued</span>
											<div className="v">
												{files.length}
												{files.length > 0 ? ` \u00b7 ${bytes(totalBytes)}` : ""}
											</div>
										</div>
										<div>
											<span className="k">Category</span>
											<div className="v">{category}</div>
										</div>
										<div>
											<span className="k">Classification</span>
											<div className="v">{classification}</div>
										</div>
									</div>

									<div className="obx-pipeline" aria-hidden="true">
										<b>Documents</b> <span>/</span> <b>Retrieval</b> <span>/</span> <b>Authorisation</b> <span>/</span>{" "}
										<b>Grounded answer</b> <span>/</span> <b>Citation</b> <span>/</span> <b>Action</b>
									</div>

									<p className="hint" style={{ marginTop: 18, fontFamily: "var(--mono)", fontSize: 11.5, lineHeight: 1.8, color: "rgba(10,11,15,.6)" }}>
										Building creates the tenant, signs you in as its administrator, and indexes anything queued above.
										Documents can be added or re-classified at any time afterwards.
									</p>
								</>
							) : null}

							{error ? (
								<div className="obx-alert" role="alert">
									{error}
								</div>
							) : null}

							<div className="obx-actions">
								{step > 0 ? (
									<button className="obx-btn ghost" onClick={() => goStep(step - 1)} disabled={busy}>
										<i aria-hidden="true">&larr;</i> Back
									</button>
								) : (
									<button className="obx-btn ghost" onClick={() => navigate("/")} disabled={busy}>
										<i aria-hidden="true">&larr;</i> Home
									</button>
								)}

								{busy ? (
									<span className="obx-busy">
										Building knowledge base <i aria-hidden="true" />
									</span>
								) : step < STEPS.length - 1 ? (
									<button className="obx-btn" onClick={() => goStep(step + 1)} disabled={!named}>
										Continue <i aria-hidden="true">&rarr;</i>
									</button>
								) : (
									<button className="obx-btn" onClick={() => void build()} disabled={!named}>
										Build knowledge base <i aria-hidden="true">&rarr;</i>
									</button>
								)}
							</div>
						</Rise>
					</div>
				)}
			</div>

			<div className="obx-strip" aria-hidden="true">
				Retrieval-first <s>//</s> Secure <s>//</s> Multi-tenant <s>//</s> Grounded <s>//</s> Actionable
			</div>
		</div>
	)
}
