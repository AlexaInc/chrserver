import { FieldBlock, FieldMapMessage } from "../sockets/wsserver";

export interface MissionConfig {
  rowSpacingM: number;
  scanSpacingM: number;
  arrivalRadiusM: number;
  headingDeg?: number;
}
export interface MissionWaypoint {
  index: number;
  latitude: number;
  longitude: number;
  blockId: string;
  blockName: string;
  plant: string;
  scan: boolean;
  row: number;
}
export interface AutonomousMission {
  missionId: string;
  patrolId: number;
  blocks: string[];
  config: MissionConfig;
  waypoints: MissionWaypoint[];
  createdAt: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function longestEdgeHeading(block: FieldBlock): number {
  let best = -1, heading = 0;
  for (let i = 0; i < block.polygon.length; i++) {
    const a = block.polygon[i], b = block.polygon[(i + 1) % block.polygon.length];
    const lat = (a[0] + b[0]) * Math.PI / 360;
    const dx = (b[1] - a[1]) * 111320 * Math.cos(lat);
    const dy = (b[0] - a[0]) * 110540;
    const len = Math.hypot(dx, dy);
    if (len > best) { best = len; heading = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360; }
  }
  return heading;
}

export function planBlock(block: FieldBlock, requested: Partial<MissionConfig>): Omit<MissionWaypoint, "index">[] {
  const rowSpacing = clamp(Number(requested.rowSpacingM) || Number(block.rowSpacingM) || 1, 0.25, 20);
  const scanSpacing = clamp(Number(requested.scanSpacingM) || Number(block.scanSpacingM) || 1, 0.25, 20);
  const heading = Number.isFinite(requested.headingDeg) ? Number(requested.headingDeg) :
    Number.isFinite(block.headingDeg) ? Number(block.headingDeg) : longestEdgeHeading(block);
  const lat0 = block.polygon.reduce((s, p) => s + p[0], 0) / block.polygon.length;
  const lng0 = block.polygon.reduce((s, p) => s + p[1], 0) / block.polygon.length;
  const toXY = ([lat, lng]: [number, number]) => [(lng - lng0) * 111320 * Math.cos(lat0 * Math.PI / 180), (lat - lat0) * 110540] as [number, number];
  const toLL = ([x, y]: [number, number]) => [lat0 + y / 110540, lng0 + x / (111320 * Math.cos(lat0 * Math.PI / 180))] as [number, number];
  const angle = heading * Math.PI / 180;
  const rot = ([x, y]: [number, number], a: number) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)] as [number, number];
  const ring = block.polygon.map(toXY).map((p) => rot(p, angle));
  const ys = ring.map((p) => p[1]);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const result: Omit<MissionWaypoint, "index">[] = [];
  let row = 0;
  for (let y = minY + Math.min(rowSpacing / 2, (maxY - minY) / 2); y <= maxY; y += rowSpacing, row++) {
    const xs: number[] = [];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y)) xs.push(xi + (y - yi) * (xj - xi) / (yj - yi));
    }
    xs.sort((a, b) => a - b);
    for (let pair = 0; pair + 1 < xs.length; pair += 2) {
      let a = xs[pair], b = xs[pair + 1];
      if (row % 2) [a, b] = [b, a];
      const distance = Math.abs(b - a);
      const count = Math.max(1, Math.floor(distance / scanSpacing));
      for (let n = 0; n <= count; n++) {
        const t = n / count;
        const local = rot([a + (b - a) * t, y], -angle);
        const [latitude, longitude] = toLL(local);
        result.push({ latitude, longitude, blockId: block.id, blockName: block.name,
          plant: block.plant, scan: n > 0 && n < count || count === 1, row });
      }
    }
  }
  if (!result.length) throw new Error(`Could not generate route inside block ${block.name}`);
  return result;
}

export function planMission(map: FieldMapMessage, blockIds: string[], requested: Partial<MissionConfig>, patrolId: number): AutonomousMission {
  const selected = blockIds.map((id) => map.blocks.find((b) => b.id === id)).filter(Boolean) as FieldBlock[];
  if (!selected.length) throw new Error("No valid mapped blocks selected");
  const config: MissionConfig = {
    rowSpacingM: clamp(Number(requested.rowSpacingM) || 1, 0.25, 20),
    scanSpacingM: clamp(Number(requested.scanSpacingM) || 1, 0.25, 20),
    arrivalRadiusM: clamp(Number(requested.arrivalRadiusM) || 2, 0.5, 10),
    headingDeg: Number.isFinite(requested.headingDeg) ? Number(requested.headingDeg) : undefined,
  };
  const waypoints = selected.flatMap((b) => planBlock(b, config)).map((w, index) => ({ ...w, index }));
  // The queued blocks are already visited in the operator-selected order.
  // After the final block, append the mapped base as a non-scan waypoint.
  if (map.base && Number.isFinite(map.base.latitude) && Number.isFinite(map.base.longitude)) {
    waypoints.push({ index: waypoints.length, latitude: map.base.latitude, longitude: map.base.longitude,
      blockId: "__base__", blockName: map.base.name || "Base", plant: "", scan: false, row: -1 });
  }
  return { missionId: `mission-${Date.now()}`, patrolId, blocks: selected.map((b) => b.id), config, waypoints, createdAt: Date.now() };
}
