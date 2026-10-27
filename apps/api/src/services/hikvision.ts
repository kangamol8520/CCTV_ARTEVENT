/**
 * Minimal Hikvision ISAPI client (HTTP Digest auth) for recording search on NVRs.
 * Untested against a live device yet — field-verify the XML shape on the first NVR.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Nvr } from "@prisma/client";
import { decryptSecret } from "../lib/crypto.ts";

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

function parseDigest(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of header.replace(/^Digest\s+/i, "").matchAll(/(\w+)=("([^"]*)"|([^,]*))/g)) {
    out[m[1]!] = m[3] ?? m[4] ?? "";
  }
  return out;
}

export async function digestFetch(url: string, user: string, pass: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const first = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
  if (first.status !== 401) return first;
  const www = first.headers.get("www-authenticate");
  if (!www || !/^Digest/i.test(www)) return first;
  const d = parseDigest(www);
  const uri = new URL(url).pathname + new URL(url).search;
  const nc = "00000001";
  const cnonce = randomBytes(8).toString("hex");
  const ha1 = md5(`${user}:${d.realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  const qop = d.qop?.split(",")[0]?.trim();
  const response = qop ? md5(`${ha1}:${d.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${d.nonce}:${ha2}`);
  let auth = `Digest username="${user}", realm="${d.realm}", nonce="${d.nonce}", uri="${uri}", response="${response}"`;
  if (d.opaque) auth += `, opaque="${d.opaque}"`;
  if (qop) auth += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (d.algorithm) auth += `, algorithm=${d.algorithm}`;
  return fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: auth }, signal: AbortSignal.timeout(15000) });
}

export interface RecordingSegment {
  start: string; // ISO
  end: string;   // ISO
  type: string;  // e.g. CMR (continuous), MOTION, ALARM
}

/** Searches recorded segments on a Hikvision NVR for one channel (1-based) within [from, to]. */
export async function searchRecordings(nvr: Nvr, channel: number, from: Date, to: Date): Promise<RecordingSegment[]> {
  const pass = (await decryptSecret(nvr.passwordEnc)) ?? "";
  const trackId = `${channel}01`;
  const segments: RecordingSegment[] = [];
  let position = 0;
  for (let page = 0; page < 20; page++) {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<CMSearchDescription>
  <searchID>${crypto.randomUUID().toUpperCase()}</searchID>
  <trackIDList><trackID>${trackId}</trackID></trackIDList>
  <timeSpanList><timeSpan><startTime>${from.toISOString().replace(/\.\d{3}Z$/, "Z")}</startTime><endTime>${to.toISOString().replace(/\.\d{3}Z$/, "Z")}</endTime></timeSpan></timeSpanList>
  <maxResults>100</maxResults>
  <searchResultPostion>${position}</searchResultPostion>
  <metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList>
</CMSearchDescription>`;
    const res = await digestFetch(`http://${nvr.host}:${nvr.httpPort}/ISAPI/ContentMgmt/search`, nvr.username ?? "admin", pass, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body,
    });
    if (!res.ok) throw new Error(`ISAPI search failed: ${res.status} ${await res.text()}`);
    const xml = await res.text();
    const items = [...xml.matchAll(/<searchMatchItem>([\s\S]*?)<\/searchMatchItem>/g)];
    for (const [, item] of items) {
      const s = /<startTime>([^<]+)<\/startTime>/.exec(item)?.[1];
      const e = /<endTime>([^<]+)<\/endTime>/.exec(item)?.[1];
      const t = /<metadataDescriptor>[^<]*?([A-Za-z]+)<\/metadataDescriptor>/.exec(item)?.[1] ?? "UNKNOWN";
      if (s && e) segments.push({ start: new Date(s).toISOString(), end: new Date(e).toISOString(), type: t });
    }
    const status = /<responseStatusStrg>([^<]+)<\/responseStatusStrg>/.exec(xml)?.[1];
    position += items.length;
    if (status !== "MORE" || items.length === 0) break;
  }
  return segments;
}

/** Quick reachability probe for an NVR / camera HTTP endpoint. */
export async function probeHttp(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/`, { method: "GET", signal: AbortSignal.timeout(3000), redirect: "manual" });
    return res.status > 0;
  } catch {
    return false;
  }
}
