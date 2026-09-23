import { useEffect } from "react"
import { useRouter } from "./hooks/useRouter.tsx"
import { useSession } from "./providers/SessionProvider.tsx"
import { Alert, Spinner } from "./components/ui.tsx"
import { LandingPage } from "./pages/LandingPage.tsx"
import { LoginPage } from "./pages/LoginPage.tsx"
import { ChatPage } from "./pages/ChatPage.tsx"
import { KnowledgePage } from "./pages/KnowledgePage.tsx"
import { UploadPage } from "./pages/UploadPage.tsx"
import { OnboardingPage } from "./pages/OnboardingPage.tsx"
import { SettingsPage } from "./pages/SettingsPage.tsx"
import {
	AdminActivityPage,
	AdminDashboardPage,
	AdminKnowledgePage,
	AdminRolesPage,
	AdminSettingsPage,
	AdminUsersPage,
} from "./pages/AdminPages.tsx"

const PUBLIC_ROUTES = new Set(["/", "/login", "/onboarding"])

export function App() {
	const { path, navigate } = useRouter()
	const { ready, me, error, authMode } = useSession()

	useEffect(() => {
		if (ready && !me && !PUBLIC_ROUTES.has(path)) navigate("/login", true)
		// Self-service onboarding is a demo-only path: with Microsoft Entra ID
		// enabled, workspaces are provisioned by an administrator.
		if (ready && authMode === "entra" && path === "/onboarding") navigate("/login", true)
	}, [ready, me, path, navigate, authMode])

	if (!ready) {
		return (
			<div className="center-page">
				<Spinner label="Starting NOVA…" />
			</div>
		)
	}

	if (error && !me) {
		return (
			<div className="center-page">
				<div className="card col">
					<Alert>{error}</Alert>
					<p className="muted" style={{ margin: 0 }}>
						Start the backend with <span className="mono">./start-dev</span> and reload this page.
					</p>
				</div>
			</div>
		)
	}

	switch (path) {
		case "/":
			return <LandingPage />
		case "/login":
			return <LoginPage />
		case "/onboarding":
			return <OnboardingPage />
		case "/chat":
			return me ? <ChatPage /> : <LoginPage />
		case "/knowledge":
			return me ? <KnowledgePage /> : <LoginPage />
		case "/knowledge/upload":
			return me ? <UploadPage /> : <LoginPage />
		case "/settings":
			return me ? <SettingsPage /> : <LoginPage />
		case "/admin":
			return me ? <AdminDashboardPage /> : <LoginPage />
		case "/admin/knowledge":
			return me ? <AdminKnowledgePage /> : <LoginPage />
		case "/admin/users":
			return me ? <AdminUsersPage /> : <LoginPage />
		case "/admin/roles":
			return me ? <AdminRolesPage /> : <LoginPage />
		case "/admin/activity":
			return me ? <AdminActivityPage /> : <LoginPage />
		case "/admin/settings":
			return me ? <AdminSettingsPage /> : <LoginPage />
		default:
			return (
				<div className="center-page">
					<div className="card col">
						<h2 style={{ margin: 0 }}>Page not found</h2>
						<p className="muted" style={{ margin: 0 }}>
							<span className="mono">{path}</span> is not a NOVA route.
						</p>
						<button className="btn primary" onClick={() => navigate("/")}>
							Back to NOVA
						</button>
					</div>
				</div>
			)
	}
}
