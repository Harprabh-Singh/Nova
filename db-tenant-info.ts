import { loadEnv, getConfig } from "./backend/src/config/index.ts";
import { Database } from "./backend/src/db/index.ts";

loadEnv();
const config = getConfig();
const db = new Database(config.database.url, { verifyMigrations: false });

try {
    const user = db.get<{ id: string; name: string; email: string; role_key: string; department: string; entra_object_id: string; status: string; max_clearance: string }>(
        "SELECT id, name, email, role_key, department, entra_object_id, status FROM users WHERE id = 'usr_636a9c75-9b43-49d0-a66a-4f03d1f9c09a'"
    );
    console.log(user);
    const role = db.get<{ max_clearance: string }>(
        "SELECT max_clearance FROM roles WHERE key = 'ADMIN' AND tenant_id = 'ten_a684c2a7-fd7c-47af-bf77-d87110efdfa5'"
    );
    console.log(role);
} finally {
    db.close();
}
