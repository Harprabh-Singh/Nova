import json, pathlib
root = pathlib.Path("/data/nova")

def edit(rel, subs):
    p = root / rel
    s = p.read_text()
    for old, new in subs:
        assert old in s, (rel, old[:70])
        s = s.replace(old, new, 1)
    p.write_text(s)
    print("ok", rel)

# A. Move the lexical-overlap gate before the authorization decision so that a
#    question whose vocabulary only matches restricted material is denied rather
#    than answered from unrelated allowed documents.
edit("backend/src/agents/knowledgeAgent.ts", [
    ("""		const nothingUseful = retrieval.chunks.length === 0 || topScore < MEDIUM_SCORE * 0.5""",
     """		// Grounding gate: a similarity score alone is not evidence. The retrieved
		// evidence must also share meaningful vocabulary with the question, otherwise
		// the nearest-neighbour chunk is simply the least-bad match in the corpus.
		const evidenceText = retrieval.chunks
			.map((c) => `${c.documentTitle} ${c.section} ${c.text}`)
			.join(" ")
			.toLowerCase()
		const contentTerms = understanding.terms.filter((t) => t.length > 3)
		const matchedTerms = contentTerms.filter((t) => evidenceText.includes(t.toLowerCase()))
		const overlapRatio = contentTerms.length === 0 ? 1 : matchedTerms.length / contentTerms.length
		const offTopic = contentTerms.length >= 3 && overlapRatio < 0.4

		const nothingUseful = retrieval.chunks.length === 0 || topScore < MEDIUM_SCORE * 0.5 || offTopic"""),
])

# remove the now-duplicated later gate block
p = root / "backend/src/agents/knowledgeAgent.ts"
s = p.read_text()
dup = """
		// Grounding gate: a similarity score alone is not evidence. The retrieved
		// evidence must also share meaningful vocabulary with the question, otherwise
		// the nearest-neighbour chunk is simply the least-bad match in the corpus.
		const evidenceText = retrieval.chunks
			.map((c) => `${c.documentTitle} ${c.section} ${c.text}`)
			.join(" ")
			.toLowerCase()
		const contentTerms = understanding.terms.filter((t) => t.length > 3)
		const matchedTerms = contentTerms.filter((t) => evidenceText.includes(t.toLowerCase()))
		const overlapRatio = contentTerms.length === 0 ? 1 : matchedTerms.length / contentTerms.length
		const offTopic = contentTerms.length >= 3 && overlapRatio < 0.4
"""
assert s.count(dup) == 1, s.count(dup)
# the duplicate is the second occurrence (after the unverifiable line); remove it there
idx = s.index("const unverifiable")
tail = s[idx:].replace(dup, "\n", 1)
s = s[:idx] + tail
p.write_text(s)
print("ok dedupe knowledgeAgent")

# B. Extractive composer: keep quantitative policy detail (days, amounts,
#    severity labels) which is exactly what users ask for.
edit("backend/src/llm/local.ts", [
    ("""				const score = overlap / Math.sqrt(sentenceTerms.length)""",
     """				// Quantitative sentences answer "how many / how long / how much" questions,
				// so a sentence carrying figures or defined labels is worth more.
				const quantitative = /\\d/.test(sentence) ? 0.35 : 0
				const score = overlap / Math.sqrt(sentenceTerms.length) + quantitative"""),
    ("""		const picked = scored.slice(0, 5)""",
     """		// De-duplicate identical sentences that appear in overlapping chunks.
		const seen = new Set<string>()
		const picked = scored
			.filter((item) => {
				const key = item.sentence.trim().toLowerCase()
				if (seen.has(key)) return false
				seen.add(key)
				return true
			})
			.slice(0, 7)"""),
])

# C. Typecheck: @types/react is not installable offline, so typecheck the backend
#    strictly and keep the web build as the frontend's compile gate.
t = root / "tsconfig.json"
c = json.loads(t.read_text())
c["include"] = ["backend/src/**/*.ts", "backend/scripts/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts"]
t.write_text(json.dumps(c, indent=2) + "\n")
print("ok tsconfig")
print("done")
