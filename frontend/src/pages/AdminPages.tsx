import { useEffect, useMemo, useState } from "react"
import { AdminConsole, Stat, Stamp } from "../components/console/ConsoleShell.tsx"
import { Link, useRouter } from "../hooks/useRouter.tsx"
import { api } from "../services/api.ts"
import { useSession } from "../providers/SessionProvider.tsx"
import type { ActivityEntry, AdminMetrics, KnowledgeDocument, Permission, Persona, Role } from "../types/index.ts"
import { dateTime, timeAgo } from "../utils/format.ts"
import { stagger, useMagnet } from "../lib/motion.tsx"
import {
	useCountInt,
	useDragPan,
	useGauge,
	useLitRows,
	usePressBloom,
	useReceipt,
	useRevealGroup,
	useSlidingIndicator,
	useWipe,
} from "../lib/console-motion.tsx"
import "../styles/console.css"

const TABS: Array<[string, string, boolean]> = [
	["/admin", "Dashboard", true],
	["/admin/knowledge", "Documents", false],
	["/admin/users", "Users", false],
	["/admin/roles", "Roles", false],
	["/admin/activity", "Activity", false],
	["/admin/settings", "Configuration", false],
]

const LADDER = ["public", "internal", "confidential", "restricted"]

/** One hairline springs between administration tabs. */
function AdminTabs() {
	const { path } = useRouter()
	const ref = useSlidingIndicator<HTMLDivElement>(path)

	return (
		<div className="wx-tabs cm-tabs" ref={ref}>
			{TABS.map(([to, label, exact]) => {
				const active = exact ? path === to : path.startsWith(to)
				return (
					<span data-tab className={active ? "is-active" : undefined} key={to}>
						<Link to={to} activeWhenExact={exact}>
							{label}
						</Link>
					</span>
				)
			})}
		</div>
	)
}

/* ============================================================== dashboard */

export function AdminDashboardPage() {
	const [metrics, setMetrics] = useState<AdminMetrics | null>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		api
			.metrics()
			.then(setMetrics)
			.catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load metrics."))
	}, [])

	const reveal = useRevealGroup<HTMLDivElement>(metrics ? "ready" : "loading")

	const documents = useCountInt(metrics?.documents.documents ?? 0)
	const active = useCountInt(metrics?.documents.activeDocuments ?? 0)
	const chunks = useCountInt(metrics?.documents.chunks ?? 0)
	const sources = useCountInt(metrics?.knowledgeSources ?? 0)
	const queries = useCountInt(metrics?.conversations.queries ?? 0)
	const threads = useCountInt(metrics?.conversations.conversations ?? 0)
	const denied = useCountInt(metrics?.conversations.accessDenied ?? 0)
	const people = useCountInt(metrics?.users ?? 0)

	const citationRate = metrics?.conversations.citationRate ?? 0
	const circumference = 2 * Math.PI * 46
	const dashOffset = useGauge(citationRate, circumference)
	const latency = metrics?.conversations.avgLatencyMs ?? 0

	const byDepartment = Object.entries(metrics?.documents.byDepartment ?? {})
	const maxDepartment = Math.max(1, ...byDepartment.map(([, count]) => Number(count)))
	const incidents = metrics?.incidents

	return (
		<AdminConsole
			eyebrow="05 / Administration"
			title="The workspace,"
			titleTail="on instruments."
			lede="What is indexed, who is asking, how often an answer carried a citation, and where permission stopped a retrieval."
		>
			<AdminTabs />
			{error ? <div className="wx-alert">{error}</div> : null}

			<div ref={reveal} className="wx-col">
				<div className="wx-grid c4">
					<Stat label="Documents" value={documents} hint="all records on file" fill={0.8} />
					<Stat
						label="Active versions"
						value={active}
						hint="live for retrieval"
						fill={active / Math.max(1, documents)}
						tone="cyan"
						delay={0.04}
					/>
					<Stat label="Indexed chunks" value={chunks} hint="retrievable passages" fill={0.66} tone="violet" delay={0.08} />
					<Stat label="Knowledge sources" value={sources} hint="connected stores" fill={0.3} delay={0.12} />
					<Stat label="Questions asked" value={queries} hint="across all personas" fill={0.72} delay={0.16} />
					<Stat label="Conversations" value={threads} hint="threads opened" fill={0.44} tone="cyan" delay={0.2} />
					<Stat label="People" value={people} hint="users in this workspace" fill={0.36} tone="violet" delay={0.24} />
					<Stat
						label="Permission refusals"
						value={denied}
						hint="retrievals stopped by clearance"
						fill={denied / Math.max(1, queries)}
						tone="magenta"
						delay={0.28}
					/>
				</div>

				<div className="wx-rule">Grounding</div>

				<div className="wx-grid c2">
					<div className="wx-slab pad-lg" data-reveal>
						<div className="wx-slab-head">
							<h3>Citation rate</h3>
							<span className="wx-chip acid">{Math.round(citationRate * 100)}%</span>
						</div>
						<div className="wx-gauge">
							<svg width="108" height="108" viewBox="0 0 108 108">
								<circle className="track" cx="54" cy="54" r="46" fill="none" strokeWidth="6" />
								<circle
									className="fill"
									cx="54"
									cy="54"
									r="46"
									fill="none"
									strokeWidth="6"
									strokeDasharray={circumference}
									strokeDashoffset={dashOffset}
								/>
							</svg>
							<div>
								<div className="n">{Math.round(citationRate * 100)}%</div>
								<div className="c">of answers carried a source</div>
								<div className="c">average latency {Math.round(latency)} ms</div>
							</div>
						</div>
					</div>

					<div className="wx-slab pad-lg" data-reveal>
						<div className="wx-slab-head">
							<h3>Documents by department</h3>
							<span className="wx-chip">{byDepartment.length} departments</span>
						</div>
						<div className="wx-col" style={{ gap: 12 }}>
							{byDepartment.map(([name, count]) => (
								<div className="wx-bar-row" key={name}>
									<div className="l">
										<span>{name}</span>
										<span>{String(count)}</span>
									</div>
									<div className="wx-bar">
										<i
											style={{ ["--fill" as string]: String(Number(count) / maxDepartment) } as React.CSSProperties}
										/>
									</div>
								</div>
							))}
							{byDepartment.length === 0 ? <div className="wx-empty">Nothing indexed yet</div> : null}
						</div>
					</div>
				</div>

				<div className="wx-rule">Machine state</div>

				<div className="wx-slab pad-lg" data-reveal>
					<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
						{Object.entries(metrics?.system ?? {}).map(([key, value]) => (
							<span className="wx-chip" key={key}>
								{key}: {String(value)}
							</span>
						))}
						{Object.keys(metrics?.system ?? {}).length === 0 ? <span className="wx-chip">awaiting health report</span> : null}
					</div>
				</div>

				<div className="wx-rule">Incidents</div>

				<div className="wx-slab pad-lg" data-reveal>
					<div className="wx-slab-head">
						<h3>Recent incidents</h3>
						<span className="wx-chip amber">
							{incidents?.open ?? 0} open / {incidents?.total ?? 0} total
						</span>
					</div>
					<div className="wx-col" style={{ gap: 8 }}>
						{(incidents?.recent ?? []).map((incident, index) => {
							const entrance = stagger(index)
							return (
								<div className={`wx-receipt ${entrance.className}`} style={entrance.style} key={incident.id}>
									<span>
										{incident.code} &middot; {incident.machineId} &middot; {incident.severity}
									</span>
									{incident.simulated ? <span className="x">SIMULATED ACTION</span> : null}
								</div>
							)
						})}
						{(incidents?.recent ?? []).length === 0 ? <div className="wx-empty">No incidents raised</div> : null}
					</div>
				</div>
			</div>
		</AdminConsole>
	)
}

/* ============================================================== documents */

export function AdminKnowledgePage() {
	const [documents, setDocuments] = useState<KnowledgeDocument[]>([])
	const [open, setOpen] = useState<string | null>(null)
	const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const { receipt, print } = useReceipt()

	const load = () => {
		api
			.knowledge()
			.then((response) => setDocuments(response.documents))
			.catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load documents."))
	}

	useEffect(load, [])

	const reveal = useRevealGroup<HTMLDivElement>(documents.length)
	const lit = useLitRows<HTMLDivElement>(documents.length)
	const record = documents.find((document) => document.id === open) ?? null
	const wipe = useWipe(open)

	const run = async (action: () => Promise<unknown>, notice: string) => {
		setBusy(true)
		try {
			await action()
			load()
			print(notice)
		} catch (caught) {
			print(caught instanceof Error ? caught.message : "That action failed.", "warn")
		} finally {
			setBusy(false)
		}
	}

	return (
		<AdminConsole
			eyebrow="06 / Documents"
			title="Control of the"
			titleTail="record."
			lede="Reclassify, move, activate a version or de-index a document entirely. Every change here changes what the assistant can cite."
		>
			<AdminTabs />
			{error ? <div className="wx-alert">{error}</div> : null}
			{receipt ? <div className={`wx-receipt ${receipt.tone === "warn" ? "warn" : ""}`}>{receipt.text}</div> : null}

			<div ref={reveal}>
				<div className="wx-ledger" ref={lit}>
					<div className="wx-ledger-head">
						<span>Document</span>
						<span>Department</span>
						<span>Class</span>
						<span>Status</span>
						<span>Updated</span>
					</div>
					{documents.map((document) => (
						<div
							className={`wx-ledger-row cm-lit${open === document.id ? " is-open" : ""}`}
							key={document.id}
							data-reveal
							data-lit
							onClick={() => {
								setConfirmDelete(null)
								setOpen(open === document.id ? null : document.id)
							}}
						>
							<span className="t">
								{document.title}
								<em className="f">{document.filename}</em>
							</span>
							<span className="wx-cell-mono">{document.department}</span>
							<span>
								<Stamp kind={document.classification}>{document.classification}</Stamp>
							</span>
							<span>
								<Stamp kind={document.status === "active" ? "ok" : "warn"}>{document.status}</Stamp>
							</span>
							<span className="wx-cell-mono">{timeAgo(document.updatedAt)}</span>
						</div>
					))}
					{documents.length === 0 ? <div className="wx-empty">No documents on file yet</div> : null}
				</div>
			</div>

			{record ? (
				<div className="wx-drawer" key={wipe.key}>
					<div className={`wx-drawer-top ${wipe.className}`}>
						<div>
							<h3>{record.title}</h3>
							<p className="wx-cell-mono">
								{record.filename} &middot; {record.category} &middot; {record.sourceType}
							</p>
						</div>
						<button className="wx-close" type="button" onClick={() => setOpen(null)}>
							Close
						</button>
					</div>

					<div className="wx-drawer-body">
						<div className="wx-grid c3">
							<label className="wx-field">
								<span>Department</span>
								<input
									defaultValue={record.department}
									onBlur={(event) => {
										const value = event.target.value.trim()
										if (!value || value === record.department) return
										run(() => api.updateDocument(record.id, { department: value }), "Department updated.")
									}}
								/>
							</label>
							<label className="wx-field">
								<span>Classification</span>
								<select
									value={record.classification}
									onChange={(event) =>
										run(
											() => api.updateDocument(record.id, { classification: event.target.value as KnowledgeDocument["classification"] }),
											"Classification updated.",
										)
									}
								>
									{LADDER.map((value) => (
										<option value={value} key={value}>
											{value}
										</option>
									))}
								</select>
							</label>
							<label className="wx-field">
								<span>Status</span>
								<select
									value={record.status}
									onChange={(event) =>
										run(
											() => api.updateDocument(record.id, { status: event.target.value as KnowledgeDocument["status"] }),
											`${record.title} is now ${event.target.value}.`,
										)
									}
								>
									<option value="active">active</option>
									<option value="archived">archived</option>
								</select>
							</label>
						</div>

						<div className="wx-rule">Who may read it</div>
						<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
							{(record.allowedRoles.length ? record.allowedRoles : ["every role cleared for this classification"]).map((role) => (
								<span className="wx-chip cyan" key={role}>
									{role}
								</span>
							))}
						</div>

						<div className="wx-rule">Versions</div>
						<div className="wx-timeline">
							{record.versions.map((version, index) => {
								const entrance = stagger(index)
								const isActive = version.status === "active"
								return (
									<div
										className={`wx-tl ${isActive ? "is-active" : ""} ${entrance.className}`}
										style={entrance.style}
										key={version.id}
									>
										<i className="node" />
										<div>
											<div className="v">v{version.version}</div>
											<div className="m">
												{version.chunkCount} chunks &middot; {version.ingestStatus} &middot; effective {version.effectiveDate || "n/a"}
											</div>
											{version.ingestError ? <div className="m">{version.ingestError}</div> : null}
										</div>
										<button
											className="wx-btn small"
											type="button"
											disabled={busy}
											onClick={() =>
												isActive
													? run(() => api.deactivateVersion(record.id, version.id), `Version ${version.version} deactivated.`)
													: run(() => api.activateVersion(record.id, version.id), `Version ${version.version} is now active.`)
											}
										>
											{isActive ? "Deactivate" : "Activate"}
										</button>
									</div>
								)
							})}
						</div>

						<div className="wx-rule">Danger</div>
						{confirmDelete === record.id ? (
							<button
								className="wx-btn danger"
								type="button"
								disabled={busy}
								onClick={() => {
									setConfirmDelete(null)
									setOpen(null)
									run(() => api.deleteDocument(record.id), `${record.title} deleted and de-indexed.`)
								}}
							>
								Confirm delete &mdash; this de-indexes every version
							</button>
						) : (
							<button className="wx-btn" type="button" onClick={() => setConfirmDelete(record.id)}>
								Delete document
							</button>
						)}
					</div>
				</div>
			) : null}
		</AdminConsole>
	)
}

/* ================================================================== users */

function PersonCard({ person, index }: { person: Persona; index: number }) {
	const magnet = useMagnet({ strength: 5 })
	const entrance = stagger(index)
	const initials = person.name
		.split(" ")
		.map((part) => part[0])
		.join("")
		.slice(0, 2)
		.toUpperCase()

	return (
		<div
			className={`wx-person ${entrance.className}`}
			style={entrance.style}
			ref={magnet.ref}
			onPointerMove={magnet.onPointerMove}
			onPointerLeave={magnet.onPointerLeave}
		>
			<div className="tile">{initials}</div>
			<div>
				<div className="nm">{person.name}</div>
				<div className="mt">{person.email}</div>
				<div className="tags">
					<span className="wx-chip">{person.roleKey}</span>
					<span className="wx-chip cyan">{person.department}</span>
					{person.isAdmin ? <span className="wx-chip acid">administrator</span> : null}
				</div>
				{person.title ? <div className="mt">{person.title}</div> : null}
			</div>
		</div>
	)
}

/**
 * Microsoft Entra identity administration (Phase 6).
 *
 * Only an administrator reaches this. Linking binds one Entra directory
 * object id (a GUID - never an email, which can change or be reassigned) to
 * one NOVA user. A pending, auto-provisioned user carries no privileges until
 * an administrator both links the identity and activates the record.
 */
function EntraIdentityPanel({ users, onChanged }: { users: Persona[]; onChanged: (message: string, tone?: "warn") => void }) {
	const [drafts, setDrafts] = useState<Record<string, string>>({})
	const [busy, setBusy] = useState<string | null>(null)

	const run = async (userId: string, action: () => Promise<unknown>, message: string) => {
		setBusy(userId)
		try {
			await action()
			onChanged(message)
		} catch (caught) {
			onChanged(caught instanceof Error ? caught.message : "That identity change was refused.", "warn")
		} finally {
			setBusy(null)
		}
	}

	return (
		<div className="wx-slab pad-lg">
			<div className="wx-slab-head">
				<h3>Microsoft Entra identities</h3>
				<span className="wx-chip">object ID, not email</span>
			</div>
			<p className="mt">
				Microsoft Entra authenticates the person. NOVA still decides the workspace, role, department and clearance, so a
				link never grants privileges by itself.
			</p>
			<div className="wx-grid c2">
				{users.map((person) => (
					<div className="wx-slab pad-lg" key={`entra-${person.id}`}>
						<div className="nm">{person.name}</div>
						<div className="mt">{person.email}</div>
						<div className="tags">
							<span className="wx-chip">{person.roleKey}</span>
							<span className={`wx-chip ${person.status === "active" ? "cyan" : "acid"}`}>{person.status ?? "active"}</span>
							{person.entraObjectId ? <span className="wx-chip">linked</span> : null}
						</div>
						<label className="wx-field">
							<span>Entra object ID</span>
							<input
								value={drafts[person.id] ?? person.entraObjectId ?? ""}
								placeholder="00000000-0000-0000-0000-000000000000"
								onChange={(event) => setDrafts({ ...drafts, [person.id]: event.target.value })}
							/>
						</label>
						<div className="wx-row" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
							<button
								className="wx-btn solid"
								type="button"
								disabled={busy === person.id}
								onClick={() =>
									void run(
										person.id,
										() => api.linkEntraIdentity(person.id, { entraObjectId: (drafts[person.id] ?? "").trim() }),
										`${person.name} linked to that Microsoft identity.`,
									)
								}
							>
								Link
							</button>
							<button
								className="wx-btn"
								type="button"
								disabled={busy === person.id || !person.entraObjectId}
								onClick={() => void run(person.id, () => api.unlinkEntraIdentity(person.id), `${person.name} unlinked.`)}
							>
								Unlink
							</button>
							<button
								className="wx-btn"
								type="button"
								disabled={busy === person.id || person.status === "active"}
								onClick={() => void run(person.id, () => api.setUserStatus(person.id, "active"), `${person.name} activated.`)}
							>
								Activate
							</button>
							<button
								className="wx-btn"
								type="button"
								disabled={busy === person.id || person.status === "disabled"}
								onClick={() => void run(person.id, () => api.setUserStatus(person.id, "disabled"), `${person.name} disabled.`)}
							>
								Disable
							</button>
						</div>
					</div>
				))}
			</div>
		</div>
	)
}

export function AdminUsersPage() {
	const { me, loadPersonas, authMode } = useSession()
	const [users, setUsers] = useState<Persona[]>([])
	const [roles, setRoles] = useState<Role[]>([])
	const [adding, setAdding] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [form, setForm] = useState({ name: "", email: "", roleKey: "", department: "", title: "" })
	const { receipt, print } = useReceipt()
	const bloom = usePressBloom()

	const load = () => {
		api
			.users()
			.then((response) => {
				setUsers(response.users)
				setRoles(response.roles)
				setForm((current) => ({ ...current, roleKey: current.roleKey || response.roles[0]?.key || "" }))
			})
			.catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load users."))
	}

	useEffect(load, [])

	const reveal = useRevealGroup<HTMLDivElement>(users.length)
	const wipe = useWipe(adding)

	const submit = async (event: React.FormEvent) => {
		event.preventDefault()
		setBusy(true)
		try {
			await api.createUser(form)
			load()
			await loadPersonas(me?.tenant.id)
			print(`${form.name} added to the workspace.`)
			setForm({ name: "", email: "", roleKey: roles[0]?.key || "", department: "", title: "" })
			setAdding(false)
		} catch (caught) {
			print(caught instanceof Error ? caught.message : "Could not create that user.", "warn")
		} finally {
			setBusy(false)
		}
	}

	return (
		<AdminConsole
			eyebrow="07 / Users"
			title="Who the answer"
			titleTail="is for."
			lede="Each person carries a role and a department. Together they decide which chunks are even eligible for retrieval."
			actions={
				<button className="wx-btn solid" type="button" onClick={() => setAdding(!adding)}>
					{adding ? "Cancel" : "Add person"}
				</button>
			}
		>
			<AdminTabs />
			{error ? <div className="wx-alert">{error}</div> : null}
			{receipt ? <div className={`wx-receipt ${receipt.tone === "warn" ? "warn" : ""}`}>{receipt.text}</div> : null}

			{adding ? (
				<form className={`wx-slab pad-lg ${wipe.className}`} key={wipe.key} onSubmit={submit}>
					<div className="wx-slab-head">
						<h3>New person</h3>
						<span className="wx-chip">becomes a selectable persona</span>
					</div>
					<div className="wx-grid c3">
						<label className="wx-field">
							<span>Name</span>
							<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
						</label>
						<label className="wx-field">
							<span>Email</span>
							<input
								type="email"
								value={form.email}
								onChange={(event) => setForm({ ...form, email: event.target.value })}
								required
							/>
						</label>
						<label className="wx-field">
							<span>Role</span>
							<select value={form.roleKey} onChange={(event) => setForm({ ...form, roleKey: event.target.value })}>
								{roles.map((role) => (
									<option value={role.key} key={role.key}>
										{role.name}
									</option>
								))}
							</select>
						</label>
						<label className="wx-field">
							<span>Department</span>
							<input
								value={form.department}
								onChange={(event) => setForm({ ...form, department: event.target.value })}
								placeholder={me?.tenant.departments?.[0] ?? "Operations"}
								required
							/>
						</label>
						<label className="wx-field">
							<span>Title</span>
							<input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
						</label>
					</div>
					<button className={`wx-btn solid ${bloom.className}`} onPointerDown={bloom.onPointerDown} type="submit" disabled={busy}>
						{busy ? "Adding\u2026" : "Add to workspace"}
					</button>
				</form>
			) : null}

			<div className="wx-rule">{users.length} people</div>
			<div className="wx-grid c2" ref={reveal}>
				{users.map((person, index) => (
					<PersonCard person={person} index={index} key={person.id} />
				))}
				{users.length === 0 ? <div className="wx-empty">No people in this workspace yet</div> : null}
			</div>

			{authMode === "entra" ? (
				<EntraIdentityPanel
					users={users}
					onChanged={(message, tone) => {
						print(message, tone)
						load()
					}}
				/>
			) : null}
		</AdminConsole>
	)
}

/* ================================================================== roles */

export function AdminRolesPage() {
	const [roles, setRoles] = useState<Role[]>([])
	const [permissions, setPermissions] = useState<Permission[]>([])
	const [departments, setDepartments] = useState<string[]>([])
	const [creating, setCreating] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [form, setForm] = useState({ key: "", name: "", canUploadKnowledge: false })
	const [grants, setGrants] = useState<Record<string, string>>({})
	const { receipt, print } = useReceipt()

	const load = () => {
		api
			.roles()
			.then((response) => {
				setRoles(response.roles)
				setPermissions(response.permissions)
				setDepartments(response.departments)
			})
			.catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load roles."))
	}

	useEffect(load, [])

	const reveal = useRevealGroup<HTMLDivElement>(roles.length)
	const wipe = useWipe(creating)

	const byRole = useMemo(() => {
		const map: Record<string, Permission[]> = {}
		permissions.forEach((permission) => {
			map[permission.roleKey] = map[permission.roleKey] ?? []
			map[permission.roleKey].push(permission)
		})
		return map
	}, [permissions])

	const submit = async (event: React.FormEvent) => {
		event.preventDefault()
		setBusy(true)
		try {
			await api.createRole({
				key: form.key.trim().toUpperCase().replace(/\s+/g, "_"),
				name: form.name,
				canUploadKnowledge: form.canUploadKnowledge,
				permissions: Object.entries(grants).map(([department, maxClassification]) => ({ department, maxClassification })),
			})
			load()
			print(`${form.name} created.`)
			setForm({ key: "", name: "", canUploadKnowledge: false })
			setGrants({})
			setCreating(false)
		} catch (caught) {
			print(caught instanceof Error ? caught.message : "Could not create that role.", "warn")
		} finally {
			setBusy(false)
		}
	}

	return (
		<AdminConsole
			eyebrow="08 / Roles"
			title="Clearance,"
			titleTail="written down."
			lede="A role is a set of grants: for each department, the highest classification it may read. Retrieval never exceeds this ceiling."
			actions={
				<button className="wx-btn solid" type="button" onClick={() => setCreating(!creating)}>
					{creating ? "Cancel" : "New role"}
				</button>
			}
		>
			<AdminTabs />
			{error ? <div className="wx-alert">{error}</div> : null}
			{receipt ? <div className={`wx-receipt ${receipt.tone === "warn" ? "warn" : ""}`}>{receipt.text}</div> : null}

			{creating ? (
				<form className={`wx-slab pad-lg ${wipe.className}`} key={wipe.key} onSubmit={submit}>
					<div className="wx-slab-head">
						<h3>New role</h3>
						<span className="wx-chip">grants apply immediately</span>
					</div>
					<div className="wx-grid c2">
						<label className="wx-field">
							<span>Key</span>
							<input
								value={form.key}
								onChange={(event) => setForm({ ...form, key: event.target.value })}
								placeholder="QUALITY_LEAD"
								required
							/>
						</label>
						<label className="wx-field">
							<span>Display name</span>
							<input
								value={form.name}
								onChange={(event) => setForm({ ...form, name: event.target.value })}
								placeholder="Quality Lead"
								required
							/>
						</label>
					</div>

					<button
						type="button"
						className={`wx-toggle ${form.canUploadKnowledge ? "on" : ""}`}
						onClick={() => setForm({ ...form, canUploadKnowledge: !form.canUploadKnowledge })}
					>
						<span className="box" />
						May upload knowledge
					</button>

					<div className="wx-rule">Grants</div>
					<div className="wx-col" style={{ gap: 10 }}>
						{departments.map((department) => (
							<div className="wx-matrix-row" key={department}>
								<span className="d">{department}</span>
								<div className="wx-pills">
									{LADDER.map((level) => (
										<button
											type="button"
											key={level}
											className={`wx-pill ${grants[department] === level ? "on" : ""}`}
											onClick={() =>
												setGrants((current) => {
													const next = { ...current }
													if (next[department] === level) delete next[department]
													else next[department] = level
													return next
												})
											}
										>
											{level}
										</button>
									))}
								</div>
							</div>
						))}
					</div>

					<button className="wx-btn solid" type="submit" disabled={busy}>
						{busy ? "Creating\u2026" : "Create role"}
					</button>
				</form>
			) : null}

			<div className="wx-rule">{roles.length} roles</div>
			<div className="wx-col" ref={reveal}>
				{roles.map((role) => {
					const list = byRole[role.key] ?? []
					return (
						<div className="wx-slab pad-lg" key={role.id} data-reveal>
							<div className="wx-slab-head">
								<h3>{role.name}</h3>
								<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
									<span className="wx-chip">{role.key}</span>
									{role.isAdmin ? <span className="wx-chip acid">administrator</span> : null}
									{role.canUploadKnowledge ? <span className="wx-chip cyan">may upload</span> : null}
								</div>
							</div>
							{role.description ? <p className="wx-cell-mono">{role.description}</p> : null}
							<div className="wx-col" style={{ gap: 8 }}>
								{list.map((permission) => {
									const ceiling = LADDER.indexOf(permission.maxClassification)
									return (
										<div className="wx-matrix-row" key={permission.id}>
											<span className="d">
												{permission.department === "*" ? "All departments" : permission.department}
											</span>
											<div className="lad">
												{LADDER.map((level, index) => (
													<span
														className={`step ${index <= ceiling ? "on" : ""}`}
														key={level}
														style={{ transitionDelay: `${index * 0.06}s` }}
													>
														{level}
													</span>
												))}
											</div>
										</div>
									)
								})}
								{list.length === 0 ? <div className="wx-empty">No grants &mdash; this role reads nothing</div> : null}
							</div>
						</div>
					)
				})}
			</div>
		</AdminConsole>
	)
}

/* =============================================================== activity */

const STATUS_FILTERS = ["all", "success", "denied", "error"]

export function AdminActivityPage() {
	const [activity, setActivity] = useState<ActivityEntry[]>([])
	const [status, setStatus] = useState("all")
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		api
			.activity()
			.then((response) => setActivity(response.activity))
			.catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load activity."))
	}, [])

	const pan = useDragPan<HTMLDivElement>()
	const visible = useMemo(
		() => activity.filter((entry) => (status === "all" ? true : entry.status === status)),
		[activity, status],
	)
	const reveal = useRevealGroup<HTMLDivElement>(`${status}:${visible.length}`)
	const lit = useLitRows<HTMLDivElement>(visible.length)

	const refusals = useCountInt(activity.filter((entry) => entry.status === "denied").length)
	const total = useCountInt(activity.length)
	const slowest = activity.reduce((max, entry) => Math.max(max, entry.latencyMs ?? 0), 0)
	const slowestCount = useCountInt(slowest)
	const maxLatency = Math.max(1, slowest)

	return (
		<AdminConsole
			eyebrow="09 / Activity"
			title="Every question,"
			titleTail="on the tape."
			lede="An append-only record of what was asked, what was served, what was refused, and how long the machine took."
		>
			<AdminTabs />
			{error ? <div className="wx-alert">{error}</div> : null}

			<div className="wx-grid c3">
				<Stat label="Events recorded" value={total} hint="all actions" fill={0.7} />
				<Stat
					label="Permission refusals"
					value={refusals}
					hint="stopped before the model"
					fill={refusals / Math.max(1, total)}
					tone="magenta"
					delay={0.05}
				/>
				<Stat label="Slowest call" value={`${slowestCount} ms`} hint="end to end" fill={0.5} tone="cyan" delay={0.1} />
			</div>

			<div className="wx-pills cm-pan" ref={pan}>
				{STATUS_FILTERS.map((value) => (
					<button
						type="button"
						key={value}
						className={`wx-pill ${status === value ? "on" : ""}`}
						onClick={() => setStatus(value)}
					>
						{value}
					</button>
				))}
			</div>

			<div className="wx-tape" ref={reveal}>
				<div ref={lit}>
					{visible.map((entry) => (
						<div
							className={`wx-tape-row cm-lit ${entry.status === "denied" ? "denied" : ""}`}
							key={entry.id}
							data-reveal
							data-lit
						>
							<span className="ts">{dateTime(entry.createdAt)}</span>
							<span className="a">
								{entry.action}
								<em className="d">
									{entry.userName} &middot; {entry.resourceType}
									{entry.resourceId ? ` #${entry.resourceId}` : ""}
								</em>
								{entry.detail ? <em className="d">{entry.detail}</em> : null}
							</span>
							<span className="wx-latency">
								<i
									style={{ ["--fill" as string]: String((entry.latencyMs ?? 0) / maxLatency) } as React.CSSProperties}
								/>
								{entry.latencyMs ? `${entry.latencyMs} ms` : "\u2014"}
							</span>
							<Stamp kind={entry.status === "success" ? "ok" : entry.status === "denied" ? "deny" : "warn"}>{entry.status}</Stamp>
						</div>
					))}
					{visible.length === 0 ? <div className="wx-empty">Nothing recorded for this filter</div> : null}
				</div>
			</div>
		</AdminConsole>
	)
}

/* ========================================================== configuration */

export function AdminSettingsPage() {
	const { refresh } = useSession()
	const [config, setConfig] = useState<Record<string, any> | null>(null)
	const [form, setForm] = useState({ assistantName: "", currency: "", departments: "" })
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const { receipt, print } = useReceipt()
	const bloom = usePressBloom()

	useEffect(() => {
		api
			.settings()
			.then((response: any) => {
				setConfig(response)
				setForm({
					assistantName: response.tenant?.settings?.assistantName ?? "",
					currency: response.tenant?.settings?.currency ?? "",
					departments: (response.tenant?.settings?.departments ?? []).join(", "),
				})
			})
			.catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load configuration."))
	}, [])

	const reveal = useRevealGroup<HTMLDivElement>(config ? "ready" : "loading")

	const save = async (event: React.FormEvent) => {
		event.preventDefault()
		setBusy(true)
		try {
			await api.updateSettings({
				assistantName: form.assistantName,
				currency: form.currency,
				departments: form.departments
					.split(",")
					.map((value) => value.trim())
					.filter(Boolean),
			})
			await refresh()
			print("Workspace configuration saved.")
		} catch (caught) {
			print(caught instanceof Error ? caught.message : "Could not save configuration.", "warn")
		} finally {
			setBusy(false)
		}
	}

	const retrieval = Object.entries(config?.retrieval ?? {})

	return (
		<AdminConsole
			eyebrow="10 / Configuration"
			title="Branding is a setting."
			titleTail="Mode is not."
			lede="Names, currency and departments are yours to edit. Execution mode is read from the environment, on purpose."
		>
			<AdminTabs />
			{error ? <div className="wx-alert">{error}</div> : null}
			{receipt ? <div className={`wx-receipt ${receipt.tone === "warn" ? "warn" : ""}`}>{receipt.text}</div> : null}

			<div className="wx-col" ref={reveal}>
				<form className="wx-slab pad-lg" onSubmit={save} data-reveal>
					<div className="wx-slab-head">
						<h3>Workspace</h3>
						<span className="wx-chip">{config?.tenant?.name ?? "loading"}</span>
					</div>
					<div className="wx-grid c2">
						<label className="wx-field">
							<span>Assistant name</span>
							<input
								value={form.assistantName}
								onChange={(event) => setForm({ ...form, assistantName: event.target.value })}
								placeholder="NOVA"
							/>
						</label>
						<label className="wx-field">
							<span>Currency</span>
							<input
								value={form.currency}
								onChange={(event) => setForm({ ...form, currency: event.target.value })}
								placeholder="INR"
							/>
						</label>
					</div>
					<label className="wx-field">
						<span>Departments</span>
						<input
							value={form.departments}
							onChange={(event) => setForm({ ...form, departments: event.target.value })}
							placeholder="HR, Finance, Operations"
						/>
					</label>
					<button className={`wx-btn solid ${bloom.className}`} onPointerDown={bloom.onPointerDown} type="submit" disabled={busy}>
						{busy ? "Saving\u2026" : "Save configuration"}
					</button>
				</form>

				<div className="wx-rule">Execution mode</div>
				<div className="wx-slab pad-lg" data-reveal>
					<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
						{Object.entries(config?.modes ?? {}).map(([key, value]) => (
							<span className="wx-chip cyan" key={key}>
								{key}: {String(value)}
							</span>
						))}
					</div>
					<p className="wx-cell-mono">
						AI_MODE, KNOWLEDGE_MODE and AUTH_MODE are read from the environment. NOVA never auto-detects cloud credentials.
					</p>
				</div>

				<div className="wx-rule">Retrieval</div>
				<div className="wx-rack" data-reveal>
					{retrieval.map(([key, value]) => (
						<div className="wx-rack-row" key={key}>
							<span className="k">{key}</span>
							<span className="n">{String(value)}</span>
						</div>
					))}
					<div className="wx-rack-row">
						<span className="k">models</span>
						<span className="n">
							llm: {config?.llmModel ?? "unknown"} &middot; embeddings: {config?.embeddingModel ?? "unknown"}
						</span>
					</div>
				</div>
			</div>
		</AdminConsole>
	)
}
