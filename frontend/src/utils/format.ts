export function timeAgo(iso: string): string {
	const ms = Date.now() - new Date(iso).getTime()
	const minutes = Math.round(ms / 60000)
	if (minutes < 1) return "just now"
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.round(minutes / 60)
	if (hours < 24) return `${hours}h ago`
	return `${Math.round(hours / 24)}d ago`
}

export function dateTime(iso: string): string {
	return new Date(iso).toLocaleString()
}

export function titleCase(value: string): string {
	return value
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase())
}

export function percent(value: number): string {
	return `${Math.round(value * 100)}%`
}
