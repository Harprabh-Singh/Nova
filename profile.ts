import { loadEnv, getConfig } from "./backend/src/config/index.ts";
import { getDb } from "./backend/src/db/index.ts";
import { createServices } from "./backend/src/api/server.ts";
import { getUser } from "./backend/src/tenants/service.ts";
import { buildAccessScope } from "./backend/src/authorization/policy.ts";
import { understandQuery } from "./backend/src/agents/queryUnderstanding.ts";

loadEnv();
const db = getDb();
const services = createServices(db);

async function profile() {
    const tenantId = "ten_a684c2a7-fd7c-47af-bf77-d87110efdfa5";
    const userId = "usr_636a9c75-9b43-49d0-a66a-4f03d1f9c09a";
    const { getTenant } = await import("./backend/src/tenants/service.ts");
    const tenant = getTenant(db, tenantId);
    if (!tenant) throw new Error("Tenant not found");
    const user = getUser(db, tenantId, userId);
    if (!user) throw new Error("User not found");
    
    // Default tenant settings structure if needed (ensure it has settings)
    tenant.settings = typeof tenant.settings === "string" ? JSON.parse(tenant.settings) : tenant.settings;

    const scope = buildAccessScope(db, { tenantId, userId, roleKey: user.roleKey });
    
    const question = "What is the NovaTech leave policy?";
    
    console.log("Starting profile of the chat request path...");
    const tStart = Date.now();
    
    // 1. Query Understanding
    const understanding = understandQuery(db, tenant.id, question);
    const filter = {
        tenantId,
        scope,
        onlyActiveVersions: true,
        departments: understanding.hintedDepartments?.length ? understanding.hintedDepartments : undefined,
    };

    // 1. query embedding
    const t1 = Date.now();
    const queryVector = await services.providers.embeddings.embedOne([question, ...understanding.terms].join(" "));
    const timeEmbed = Date.now() - t1;
    
    // 2. Azure AI Search request
    const config = getConfig();
    const t2 = Date.now();
    const raw = await services.providers.vectorStore.search(
        queryVector,
        [question, ...understanding.terms],
        filter,
        config.retrieval.candidates
    );
    const timeSearch = Date.now() - t2;
    
    // Azure Search count matches (also part of Search latency typically)
    const t2a = Date.now();
    const restrictedMatches = (await services.providers.vectorStore.countMatchingOutsideScope?.([question, ...understanding.terms], filter)) ?? 0;
    const timeSearchProbe = Date.now() - t2a;
    
    // 3. result processing/reranking
    const t3 = Date.now();
    const { rerank } = await import("./backend/src/retrieval/rerank.ts");
    const candidates = raw.map(r => ({ ...r, score: 0 }));
    const chunks = rerank(
        candidates,
        {
            vectorWeight: config.retrieval.vectorWeight,
            keywordWeight: config.retrieval.keywordWeight,
            userDepartment: scope.department,
            hintedDepartments: understanding.hintedDepartments,
            hintedCategories: understanding.hintedCategories,
        },
        config.retrieval.topK
    );
    const timeRerank = Date.now() - t3;
    
    // 4. Foundry chat request
    const t4 = Date.now();
    const { buildSystemPrompt, renderEvidence } = await import("./backend/src/agents/prompt.ts");
    const evidence = chunks.slice(0, 6).map((c, i) => ({
        ref: String(i + 1),
        documentTitle: c.documentTitle,
        department: c.department,
        version: c.version,
        section: c.section,
        text: c.text,
    }));
    const userContext = "- Name: Admin User";
    const messages = [
        { role: "system" as const, content: buildSystemPrompt(tenant, userContext) },
        { role: "user" as const, content: `${renderEvidence(evidence)}\n\nQuestion: ${understanding.normalized}` }
    ];
    await services.providers.llm.complete({ messages, evidence, temperature: 0.1 });
    const timeChat = Date.now() - t4;
    
    // 5. database persistence
    const t5 = Date.now();
    const conv = services.conversations.create(tenantId, userId, "Profile Test");
    services.conversations.addMessage({
        tenantId,
        conversationId: conv.id,
        userId,
        role: "assistant",
        content: "Profile test answer",
        provider: "profile",
        latencyMs: 100,
        citations: []
    });
    const { recordActivity } = await import("./backend/src/observability/logger.ts");
    recordActivity(db, {
        tenantId,
        userId,
        userName: user.name,
        action: "Profile test",
        resourceType: "knowledge",
        status: "success",
        requestId: "profile"
    });
    const timeDb = Date.now() - t5;
    
    const timeTotal = Date.now() - tStart;
    
    console.log("-----------------------------------------");
    console.log(`1. query embedding:              ${timeEmbed} ms`);
    console.log(`2. Azure AI Search (query):      ${timeSearch} ms`);
    console.log(`   Azure AI Search (probe):      ${timeSearchProbe} ms`);
    console.log(`3. result processing/reranking:  ${timeRerank} ms`);
    console.log(`4. Foundry chat request:         ${timeChat} ms`);
    console.log(`5. database persistence:         ${timeDb} ms`);
    console.log(`6. TOTAL SCRIPT EXECUTION TIME:  ${timeTotal} ms`);
    console.log("-----------------------------------------");
}

profile().catch(console.error).finally(() => db.close());
