import json, pathlib
root = pathlib.Path("/data/nova")

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

p = root / "backend/src/agents/knowledgeAgent.ts"
s = p.read_text()
n = s.count(dup)
print("dup count", n)
if n == 2:
    idx = s.index("const unverifiable")
    s = s[:idx] + s[idx:].replace(dup, "\n", 1)
    p.write_text(s)
    print("removed duplicate gate")

# ensure later branch uses offTopic in insufficient decision
s = p.read_text()
if "|| offTopic) {" not in s.split("const unverifiable")[1][:600]:
    old = "\t\tif (retrieval.chunks.length === 0 || unverifiable) {"
    assert old in s
    s = s.replace(old, "\t\tif (retrieval.chunks.length === 0 || unverifiable || offTopic) {", 1)
    p.write_text(s)
    print("insufficient branch now honours offTopic")

# B. extractive composer improvements
p2 = root / "backend/src/llm/local.ts"
s2 = p2.read_text()
old_score = "\t\t\t\tconst score = overlap / Math.sqrt(sentenceTerms.length)"
if "quantitative" not in s2:
    assert old_score in s2
    s2 = s2.replace(
        old_score,
        "\t\t\t\t// Quantitative sentences answer \"how many / how long / how much\" questions,\n"
        "\t\t\t\t// so a sentence carrying figures or defined labels is worth more.\n"
        "\t\t\t\tconst quantitative = /\\d/.test(sentence) ? 0.35 : 0\n"
        "\t\t\t\tconst score = overlap / Math.sqrt(sentenceTerms.length) + quantitative",
        1,
    )
    old_pick = "\t\tconst picked = scored.slice(0, 5)"
    assert old_pick in s2
    s2 = s2.replace(
        old_pick,
        "\t\t// De-duplicate identical sentences that appear in overlapping chunks.\n"
        "\t\tconst seen = new Set<string>()\n"
        "\t\tconst picked = scored\n"
        "\t\t\t.filter((item) => {\n"
        "\t\t\t\tconst key = item.sentence.trim().toLowerCase()\n"
        "\t\t\t\tif (seen.has(key)) return false\n"
        "\t\t\t\tseen.add(key)\n"
        "\t\t\t\treturn true\n"
        "\t\t\t})\n"
        "\t\t\t.slice(0, 7)",
        1,
    )
    p2.write_text(s2)
    print("ok llm/local.ts")

# C. tsconfig: typecheck backend/scripts/tests (no @types/react offline)
t = root / "tsconfig.json"
c = json.loads(t.read_text())
c["include"] = ["backend/src/**/*.ts", "backend/scripts/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts"]
t.write_text(json.dumps(c, indent=2) + "\n")
print("ok tsconfig")
