import { prisma } from "./prisma.ts";

export async function audit(userId: number | null, action: string, entity: string, entityId?: string | number, detail?: unknown) {
  try {
    await prisma.auditLog.create({
      data: {
        userId,
        action,
        entity,
        entityId: entityId === undefined ? null : String(entityId),
        detail: detail === undefined ? null : JSON.stringify(detail),
      },
    });
  } catch (e) {
    console.error("[audit] failed", e);
  }
}
