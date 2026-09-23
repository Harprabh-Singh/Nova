import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"

type RouterValue = { path: string; navigate: (to: string, replace?: boolean) => void }

const RouterContext = createContext<RouterValue>({ path: "/", navigate: () => {} })

export function RouterProvider({ children }: { children: ReactNode }) {
	const [path, setPath] = useState(() => window.location.pathname || "/")

	useEffect(() => {
		const onPop = () => setPath(window.location.pathname || "/")
		window.addEventListener("popstate", onPop)
		return () => window.removeEventListener("popstate", onPop)
	}, [])

	const navigate = useCallback((to: string, replace = false) => {
		if (to === window.location.pathname) return
		if (replace) window.history.replaceState({}, "", to)
		else window.history.pushState({}, "", to)
		setPath(to)
		window.scrollTo(0, 0)
	}, [])

	const value = useMemo(() => ({ path, navigate }), [path, navigate])
	return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>
}

export function useRouter(): RouterValue {
	return useContext(RouterContext)
}

export function Link({
	to,
	children,
	className,
	activeWhenExact,
}: {
	to: string
	children: ReactNode
	className?: string
	activeWhenExact?: boolean
}) {
	const { path, navigate } = useRouter()
	const active = activeWhenExact ? path === to : path === to || path.startsWith(`${to}/`)
	return (
		<a
			href={to}
			className={[className, active ? "active" : ""].filter(Boolean).join(" ")}
			onClick={(event) => {
				if (event.metaKey || event.ctrlKey) return
				event.preventDefault()
				navigate(to)
			}}
		>
			{children}
		</a>
	)
}
