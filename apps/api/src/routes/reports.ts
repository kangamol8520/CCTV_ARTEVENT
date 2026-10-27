/** Excel exports: camera inventory and event log. */
import { Elysia, t } from "elysia";
import * as XLSX from "xlsx";
import { prisma } from "../lib/prisma.ts";
import { authGuard } from "../lib/auth.ts";
import { eventWhere } from "./events.ts";

function workbookResponse(sheets: { name: string; rows: Record<string, unknown>[] }[], filename: string) {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(s.rows), s.name.slice(0, 31));
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return new Response(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

const stamp = () => new Date().toISOString().slice(0, 10);

export const reportRoutes = new Elysia({ prefix: "/reports" })
  .use(authGuard)
  .get("/cameras.xlsx", async () => {
    const cams = await prisma.camera.findMany({ include: { floor: true, room: true, nvr: true }, orderBy: [{ floorId: "asc" }, { deviceNo: "asc" }] });
    const rows = cams.map((c) => ({
      DeviceNo: c.deviceNo, Name: c.name, Floor: c.floor?.name ?? "", Room: c.room?.name ?? "", Brand: c.brand, Protocol: c.protocol,
      IP: c.host ?? "", NVR: c.nvr?.name ?? "", Channel: c.nvrChannel ?? "", Status: c.status, Enabled: c.isEnabled ? "Y" : "N",
      LastSeen: c.lastSeenAt?.toISOString() ?? "", Description: c.description ?? "", ImportFlags: c.importFlags ?? "",
    }));
    const nvrs = await prisma.nvr.findMany({ include: { _count: { select: { cameras: true } } }, orderBy: { name: "asc" } });
    const nvrRows = nvrs.map((n) => ({ Name: n.name, Brand: n.brand, Model: n.model ?? "", Serial: n.serialNo ?? "", IP: n.host, HttpPort: n.httpPort, RtspPort: n.rtspPort, Cameras: n._count.cameras, Status: n.status }));
    return workbookResponse([{ name: "Cameras", rows }, { name: "NVRs", rows: nvrRows }], `camera-inventory-${stamp()}.xlsx`);
  })
  .get(
    "/events.xlsx",
    async ({ query }) => {
      const events = await prisma.event.findMany({
        where: eventWhere(query),
        include: { camera: { include: { floor: true, room: true } }, createdBy: true, acknowledgedBy: true },
        orderBy: { startedAt: "desc" },
        take: 10000,
      });
      const rows = events.map((e) => ({
        ID: e.id, StartedAt: e.startedAt.toISOString(), EndedAt: e.endedAt?.toISOString() ?? "", Type: e.type, Severity: e.severity, Source: e.source,
        Title: e.title, Camera: e.camera?.deviceNo ?? "", CameraName: e.camera?.name ?? "", Floor: e.camera?.floor?.name ?? "", Room: e.camera?.room?.name ?? "",
        Description: e.description ?? "", CreatedBy: e.createdBy?.displayName ?? "", AcknowledgedBy: e.acknowledgedBy?.displayName ?? "", AcknowledgedAt: e.acknowledgedAt?.toISOString() ?? "",
      }));
      return workbookResponse([{ name: "Events", rows }], `events-${stamp()}.xlsx`);
    },
    { query: t.Object({ from: t.Optional(t.String()), to: t.Optional(t.String()), cameraId: t.Optional(t.String()), type: t.Optional(t.String()), severity: t.Optional(t.String()), source: t.Optional(t.String()), floorId: t.Optional(t.String()) }) },
  );
