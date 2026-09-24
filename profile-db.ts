import { loadEnv, getConfig } from "./backend/src/config/index.ts";
import { getDb } from "./backend/src/db/index.ts";
import { ConversationService } from "./backend/src/conversations/service.ts";
import { recordActivity } from "./backend/src/observability/logger.ts";

loadEnv();

async function profileDb() {
    console.log("Measuring DB connection acquisition...");
    const tStart = Date.now();
    const db = getDb();
    
    // warm up / get connection overhead
    const t0 = Date.now();
    db.get("SELECT 1");
    const tConnection = Date.now() - t0;
    
    const tenantId = "ten_a684c2a7-fd7c-47af-bf77-d87110efdfa5";
    const userId = "usr_636a9c75-9b43-49d0-a66a-4f03d1f9c09a";
    const conversations = new ConversationService(db);

    console.log("Measuring conversation lookup/create...");
    const t1 = Date.now();
    const conv = conversations.create(tenantId, userId, "DB Profile Test");
    const tConvCreate = Date.now() - t1;

    console.log("Measuring user message persistence...");
    const t2 = Date.now();
    conversations.addMessage({
        tenantId,
        conversationId: conv.id,
        userId,
        role: "user",
        content: "Hello, this is a test.",
    });
    const tUserMsg = Date.now() - t2;

    console.log("Measuring assistant message persistence (with 6 citations)...");
    const citations = Array(6).fill(0).map((_, i) => ({
        documentId: "doc_1", versionId: "ver_1", chunkId: "chunk_" + i,
        documentTitle: "Test Doc", department: "HR", version: "v1", section: "1.0", score: 0.9
    }));
    
    const t3 = Date.now();
    
    // Measure the sub-components of assistant message
    let tAssistantMsgInsert = 0;
    let tCitationInsert = 0;
    let tAssistantTotal = 0;
    
    // To measure citations separately, let's time the full addMessage, but wait, addMessage does it all.
    // I will measure full addMessage for assistant
    conversations.addMessage({
        tenantId,
        conversationId: conv.id,
        userId,
        role: "assistant",
        content: "Here is the answer.",
        citations
    });
    tAssistantTotal = Date.now() - t3;
    
    console.log("Measuring explicit citation persistence separately to isolate...");
    const t4 = Date.now();
    const mockMsgId = "msg_mock_" + Date.now();
    db.run(`INSERT INTO messages (id, tenant_id, conversation_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, 
        mockMsgId, tenantId, conv.id, userId, "assistant", "mock", new Date().toISOString());
    const t4b = Date.now();
    for (const citation of citations) {
        db.run(
            `INSERT INTO citations (id, tenant_id, message_id, document_id, version_id, chunk_id, document_title, department, version, section, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            "cit_mock_" + Math.random(), tenantId, mockMsgId, citation.documentId, citation.versionId, citation.chunkId, citation.documentTitle, citation.department, citation.version, citation.section, citation.score
        );
    }
    const tCitationExplicit = Date.now() - t4b;

    console.log("Measuring activity/audit persistence...");
    const t5 = Date.now();
    recordActivity(db, {
        tenantId, userId, userName: "Test", action: "Test", resourceType: "test", status: "success"
    });
    const tActivity = Date.now() - t5;

    console.log("Measuring transaction commit latency...");
    const t6 = Date.now();
    db.transaction(() => {
        db.run("SELECT 1");
    });
    const tTransaction = Date.now() - t6;

    console.log("Measuring connection release...");
    const t7 = Date.now();
    db.close();
    const tRelease = Date.now() - t7;

    console.log("-----------------------------------------");
    console.log(`1. DB connection overhead (1 query): ${tConnection} ms`);
    console.log(`2. conversation lookup/create:       ${tConvCreate} ms`);
    console.log(`3. user message persistence:         ${tUserMsg} ms`);
    console.log(`4. assistant message total:          ${tAssistantTotal} ms`);
    console.log(`5. citation persistence (6 items):   ${tCitationExplicit} ms (avg ${Math.round(tCitationExplicit/6)}ms each)`);
    console.log(`6. activity/audit persistence:       ${tActivity} ms`);
    console.log(`7. transaction latency (BEGIN/SEL/COMM): ${tTransaction} ms`);
    console.log(`8. connection release:               ${tRelease} ms`);
    console.log("-----------------------------------------");
}

profileDb().catch(console.error);
