import { ConsoleShell, Stamp } from "../components/console/ConsoleShell.tsx"
import { useSession } from "../providers/SessionProvider.tsx"
import { stagger, useSpotlight } from "../lib/motion.tsx"
import { useRevealGroup } from "../lib/console-motion.tsx"
import "../styles/console.css"

const LADDER = ["public", "internal", "confidential", "restricted"]

export function SettingsPage() {
	const { me, health } = useSession()
	const spot = useSpotlight<HTMLDivElement>()
	const reveal = useRevealGroup<HTMLDivElement>(me?.user.id ?? "anon")

	const initials = (me?.user.name ?? "?")
		.split(" ")
		.map((part) => part[0])
		.join("")
		.slice(0, 2)
		.toUpperCase()

	const permissions = me?.permissions ?? []
	const providers = Object.entries(health?.providers ?? {})

	return (
		<ConsoleShell
			eyebrow="04 / Settings"
			title="Your badge, and"
			titleTail="what it opens."
			lede="This page is not preferences. It is the identity the retriever uses, the clearance attached to it, and the machine currently answering you."
		>
			<div className="wx-col" ref={reveal}>
				<div className="wx-idcard mo-spot" ref={spot} data-reveal>
					<div className="wx-idcard-top">
						<div className="tile">{initials}</div>
						<div>
							<h3>{me?.user.name}</h3>
							<p>{me?.user.title || me?.role?.name}</p>
						</div>
					</div>

					<div className="wx-idcard-rows">
						<div>
							<span className="k">Email</span>
							<span className="v">{me?.user.email}</span>
						</div>
						<div>
							<span className="k">Role</span>
							<span className="v">
								{me?.role?.name} <em>({me?.user.roleKey})</em>
							</span>
						</div>
						<div>
							<span className="k">Department</span>
							<span className="v">{me?.user.department}</span>
						</div>
						<div>
							<span className="k">Workspace</span>
							<span className="v">
								{me?.tenant.name} <em>({me?.tenant.industry})</em>
							</span>
						</div>
						<div>
							<span className="k">Authentication</span>
							<span className="v">
								{me?.auth.mode}
								{me && !me.auth.isProduction ? <span className="wx-chip amber">non-production</span> : null}
							</span>
						</div>
					</div>

					<div className="wx-idcard-foot">
						<span>{me?.scope.isAdmin ? "Administrator" : "Member"}</span>
						<span>{me?.scope.canUploadKnowledge ? "May upload knowledge" : "Read-only knowledge"}</span>
					</div>
				</div>

				<div className="wx-rule">Knowledge access</div>

				<div className="wx-slab pad-lg" data-reveal>
					<div className="wx-slab-head">
						<h3>Clearance matrix</h3>
						<span className="wx-chip">{permissions.length} grants</span>
					</div>
					<div className="wx-col" style={{ gap: 10 }}>
						{permissions.map((permission, index) => {
							const ceiling = LADDER.indexOf(permission.maxClassification)
							const entrance = stagger(index)
							return (
								<div
									className={`wx-matrix-row ${entrance.className}`}
									style={entrance.style}
									key={permission.id ?? `${permission.department}-${index}`}
								>
									<span className="d">
										{permission.department === "*" ? "All departments" : permission.department}
									</span>
									<div className="lad">
										{LADDER.map((level, step) => (
											<span
												className={`step ${step <= ceiling ? "on" : ""}`}
												key={level}
												style={{ transitionDelay: `${0.12 + step * 0.06}s` }}
											>
												{level}
											</span>
										))}
									</div>
								</div>
							)
						})}
						{permissions.length === 0 ? <div className="wx-empty">No grants on this role yet</div> : null}
					</div>
					<p className="wx-cell-mono">Retrieval is filtered by these grants before anything reaches the model.</p>
				</div>

				<div className="wx-rule">Execution mode</div>

				<div className="wx-slab pad-lg" data-reveal>
					<div className="wx-slab-head">
						<h3>How this instance runs</h3>
						<span className="wx-chip acid">app: {health?.appMode ?? "unknown"}</span>
					</div>
					<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
						{Object.entries(health?.modes ?? {}).map(([key, value]) => (
							<span className="wx-chip cyan" key={key}>
								{key}: {String(value)}
							</span>
						))}
					</div>
					<p className="wx-cell-mono">
						Switching to Azure is a configuration change only (AI_MODE, KNOWLEDGE_MODE, AUTH_MODE). NOVA never auto-detects
						cloud credentials.
					</p>
				</div>

				<div className="wx-rule">Providers</div>

				<div className="wx-rack" data-reveal>
					{providers.map(([key, provider]: [string, any]) => (
						<div className="wx-rack-row" key={key}>
							<span className="k">{key}</span>
							<span className="n">{provider?.name ?? String(provider)}</span>
							<span className="n">{provider?.model ?? provider?.mode ?? "\u2014"}</span>
							<Stamp kind={provider?.verified === true ? "ok" : provider?.verified === false ? "warn" : undefined}>
								{provider?.verified === true ? "verified" : provider?.verified === false ? "unverified" : "unknown"}
							</Stamp>
						</div>
					))}
					{providers.length === 0 ? <div className="wx-empty">No provider report from the backend</div> : null}
				</div>
			</div>
		</ConsoleShell>
	)
}

export default SettingsPage
