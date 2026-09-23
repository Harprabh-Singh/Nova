import { createRoot } from "react-dom/client"
import { StrictMode } from "react"
import "./styles.css"
import { App } from "./App.tsx"
import { RouterProvider } from "./hooks/useRouter.tsx"
import { SessionProvider } from "./providers/SessionProvider.tsx"

const container = document.getElementById("root")
if (!container) throw new Error("Missing #root container")

createRoot(container).render(
	<StrictMode>
		<RouterProvider>
			<SessionProvider>
				<App />
			</SessionProvider>
		</RouterProvider>
	</StrictMode>,
)
