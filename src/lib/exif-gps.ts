export interface GpsCoords {
  lat: number;
  lon: number;
}

/**
 * Extract GPS coordinates from a JPEG file's EXIF metadata.
 * Returns null for non-JPEG files, files without EXIF, or files without a GPS IFD.
 * Dependency-free: reads the APP1/TIFF structure directly.
 */
export async function extractGps(file: File): Promise<GpsCoords | null> {
  try {
    // EXIF lives in an APP1 segment right after SOI; 256 KB is more than enough.
    const buf = await file.slice(0, 256 * 1024).arrayBuffer();
    const view = new DataView(buf);
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null; // not JPEG

    let offset = 2;
    while (offset + 4 <= view.byteLength) {
      const marker = view.getUint16(offset);
      if ((marker & 0xff00) !== 0xff00) break;
      const size = view.getUint16(offset + 2);
      if (marker === 0xffe1 && offset + 10 <= view.byteLength) {
        // APP1 — check for "Exif\0\0" header
        if (view.getUint32(offset + 4) === 0x45786966 && view.getUint16(offset + 8) === 0) {
          return parseTiffGps(view, offset + 10);
        }
      }
      if (marker === 0xffda) break; // start of scan — no EXIF past this point
      offset += 2 + size;
    }
  } catch {
    // truncated/malformed metadata — treat as "no GPS"
  }
  return null;
}

function parseTiffGps(view: DataView, tiff: number): GpsCoords | null {
  const byteOrder = view.getUint16(tiff);
  const little = byteOrder === 0x4949;
  if (!little && byteOrder !== 0x4d4d) return null;
  const u16 = (o: number) => view.getUint16(o, little);
  const u32 = (o: number) => view.getUint32(o, little);
  if (u16(tiff + 2) !== 42) return null;

  // Find the GPS IFD pointer (tag 0x8825) in IFD0.
  const gpsIfdRel = findTag(view, tiff, tiff + u32(tiff + 4), 0x8825, little)?.valueU32;
  if (gpsIfdRel === undefined) return null;
  const gpsIfd = tiff + gpsIfdRel;

  const latRef = findTag(view, tiff, gpsIfd, 0x0001, little)?.ascii; // "N" | "S"
  const lat = findTag(view, tiff, gpsIfd, 0x0002, little)?.dms;
  const lonRef = findTag(view, tiff, gpsIfd, 0x0003, little)?.ascii; // "E" | "W"
  const lon = findTag(view, tiff, gpsIfd, 0x0004, little)?.dms;
  if (lat === undefined || lon === undefined) return null;

  const latSigned = latRef === "S" ? -lat : lat;
  const lonSigned = lonRef === "W" ? -lon : lon;
  if (!Number.isFinite(latSigned) || !Number.isFinite(lonSigned)) return null;
  if (Math.abs(latSigned) > 90 || Math.abs(lonSigned) > 180) return null;
  if (latSigned === 0 && lonSigned === 0) return null; // common "no fix" placeholder
  return { lat: latSigned, lon: lonSigned };
}

interface TagValue {
  valueU32?: number;
  ascii?: string;
  /** degrees + minutes/60 + seconds/3600, from a 3-RATIONAL value */
  dms?: number;
}

function findTag(
  view: DataView,
  tiff: number,
  ifd: number,
  tag: number,
  little: boolean
): TagValue | null {
  const u16 = (o: number) => view.getUint16(o, little);
  const u32 = (o: number) => view.getUint32(o, little);
  if (ifd + 2 > view.byteLength) return null;
  const count = u16(ifd);

  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > view.byteLength) return null;
    if (u16(entry) !== tag) continue;

    const type = u16(entry + 2);
    const num = u32(entry + 4);
    const result: TagValue = {};

    if (type === 3 && num === 1) {
      result.valueU32 = u16(entry + 8); // SHORT, stored inline
    } else if (type === 4 && num === 1) {
      result.valueU32 = u32(entry + 8); // LONG, stored inline
    } else if (type === 2) {
      // ASCII: <=4 bytes stored inline, otherwise at offset
      const start = num <= 4 ? entry + 8 : tiff + u32(entry + 8);
      let s = "";
      for (let j = 0; j < num && start + j < view.byteLength; j++) {
        const c = view.getUint8(start + j);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      result.ascii = s;
    } else if (type === 5 && num === 3) {
      // 3 RATIONALs (deg, min, sec), always at offset
      const start = tiff + u32(entry + 8);
      if (start + 24 > view.byteLength) return null;
      const parts: number[] = [];
      for (let j = 0; j < 3; j++) {
        const n = u32(start + j * 8);
        const d = u32(start + j * 8 + 4);
        parts.push(d === 0 ? 0 : n / d);
      }
      result.dms = parts[0] + parts[1] / 60 + parts[2] / 3600;
    }
    return result;
  }
  return null;
}
