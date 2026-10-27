export type Role = "ADMIN" | "OPERATOR" | "VIEWER";
export interface AuthUser { id: number; username: string; displayName: string; role: Role }

export interface FloorNode { id: number; code: string; name: string; cameraCount: number; rooms: { id: number; code: string; name: string; cameraCount: number }[] }

export interface Camera {
  id: number; deviceNo: string; name: string; description: string | null; brand: string; model: string | null;
  protocol: "HIKVISION" | "ONVIF" | "RTSP" | "NVR_CHANNEL"; host: string | null; rtspPort: number; httpPort: number; username: string | null;
  mainStreamPath: string | null; subStreamPath: string | null; nvrId: number | null; nvrChannel: number | null; floorId: number | null; roomId: number | null;
  isEnabled: boolean; status: "UNKNOWN" | "ONLINE" | "OFFLINE"; lastSeenAt: string | null; sortOrder: number; importFlags: string | null;
  floor: { id: number; code: string; name: string } | null; room: { id: number; code: string; name: string } | null; nvr: { id: number; name: string; host: string } | null;
  streams: { main: string; sub: string; go2rtcUrl: string };
}

export interface Nvr {
  id: number; name: string; legacyDeviceNo: string | null; brand: string; model: string | null; serialNo: string | null; host: string; httpPort: number; rtspPort: number;
  username: string | null; maxChannels: number; channelMainPath: string; channelSubPath: string; playbackPath: string; status: string; lastSeenAt: string | null; notes: string | null;
  floorId: number | null; roomId: number | null; _count: { cameras: number };
}

export interface CameraGroup { id: number; name: string; description: string | null; gridColumns: number; sortOrder: number; members: { id: number; deviceNo: string; name: string; status: string; isEnabled: boolean; sortOrder: number }[] }

export interface Event {
  id: number; cameraId: number | null; type: string; severity: string; source: string; title: string; description: string | null; startedAt: string; endedAt: string | null;
  acknowledgedAt: string | null; createdAt: string;
  camera: { id: number; deviceNo: string; name: string; floor: { name: string } | null; room: { name: string } | null } | null;
  createdBy: { id: number; displayName: string } | null; acknowledgedBy: { id: number; displayName: string } | null;
}

export interface SystemStatus { cameras: { total: number; online: number }; nvrs: { total: number; online: number }; go2rtc: { reachable: boolean; publicUrl: string; activeStreams: number; viewers: number } }
