import { AccessPage } from "../components/access/AccessPage.tsx"

/**
 * /login — the NOVA access chamber.
 *
 * The route is kept so every existing redirect (App.tsx guards, "Enter the
 * demo") keeps working; the experience itself lives in components/access.
 *
 * This is demo authentication, not a production identity provider, and the
 * page says so. The frontend only chooses which demo session to start — the
 * backend still resolves tenant, user, role and permissions, and retrieval
 * enforces them before knowledge reaches the model.
 */
export function LoginPage() {
	return <AccessPage />
}
