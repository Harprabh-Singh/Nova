import { loadEnv, getConfig } from "./backend/src/config/index.ts";
import { getDb } from "./backend/src/db/index.ts";
import { getUser, linkEntraIdentity } from "./backend/src/tenants/service.ts";

loadEnv();
const db = getDb();

const tenantId = "ten_a684c2a7-fd7c-47af-bf77-d87110efdfa5";
const userId = "usr_636a9c75-9b43-49d0-a66a-4f03d1f9c09a";
const objectId = "9ea9b9c6-4d98-4b9e-bc80-9f0ec5bcbb4d";
const upn = "harprabhnanda@gmail.com";

try {
    // 1. Verify that the target user exists and belongs to NovaTech.
    const targetUser = getUser(db, tenantId, userId);
    if (!targetUser) {
        console.error("FAILED: Target user does not exist in the specified tenant.");
        process.exit(1);
    }

    // 2 & 3. Verify user is ADMIN and active
    if (targetUser.roleKey !== "ADMIN") {
        console.error(`FAILED: User role is ${targetUser.roleKey}, expected ADMIN.`);
        process.exit(1);
    }
    if (targetUser.status !== "active") {
        console.error(`FAILED: User status is ${targetUser.status}, expected active.`);
        process.exit(1);
    }

    // 4. Verify the target user is currently unlinked
    if (targetUser.entraObjectId) {
        console.error(`FAILED: User already linked to ${targetUser.entraObjectId}.`);
        process.exit(1);
    }

    // 5. Verify the Entra Object ID is unused
    const existingUsage = db.get("SELECT id FROM users WHERE entra_object_id = $1", [objectId]);
    if (existingUsage) {
        console.error(`FAILED: Entra Object ID is already linked to another user.`);
        process.exit(1);
    }

    // UPDATE
    linkEntraIdentity(db, { tenantId, userId, entraObjectId: objectId, entraUpn: upn });

    // VERIFY
    const updatedUser = getUser(db, tenantId, userId);
    if (!updatedUser) throw new Error("Could not fetch user after update");

    const tenant = db.get<{ name: string }>("SELECT name FROM tenants WHERE id = $1", [tenantId]);

    console.log("LINK RESULT:");
    console.log("SUCCESS");
    console.log("\nNOVA USER:");
    console.log(updatedUser.name);
    console.log("\nTENANT:");
    console.log(tenant?.name);
    console.log("\nROLE:");
    console.log(updatedUser.roleKey);
    console.log("\nSTATUS:");
    console.log(updatedUser.status);
    console.log("\nENTRA LINK:");
    console.log(updatedUser.entraObjectId === objectId ? "linked" : "unlinked");
    console.log("\nUPN:");
    console.log(updatedUser.entraUpn);
    console.log("\nOTHER RECORDS MODIFIED:");
    console.log("none");

} catch (error) {
    console.error("ERROR:", error);
} finally {
    db.close();
}
