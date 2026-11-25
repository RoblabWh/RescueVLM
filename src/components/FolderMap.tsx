"use client";

import { useEffect, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import type * as Leaflet from "leaflet";

export interface MapPoint {
  /** 0-based index into the folder image list. */
  index: number;
  name: string;
  lat: number;
  lon: number;
  /** Position in the current highlight ranking; -1 = not highlighted. */
  rank: number;
  note?: string;
}

interface Props {
  points: MapPoint[];
  onSelect: (index: number) => void;
}

function markerIcon(L: typeof Leaflet, p: MapPoint) {
  const isTop = p.rank === 0;
  const isHighlighted = p.rank >= 0;
  const bg = isTop ? "#fbbf24" : isHighlighted ? "#38bdf8" : "#3f3f46";
  const fg = isHighlighted ? "#000" : "#e4e4e7";
  const border = isHighlighted ? "#18181b" : "#a1a1aa";
  return L.divIcon({
    className: "",
    html: `<div style="display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:9999px;background:${bg};color:${fg};border:2px solid ${border};font:bold 11px sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.6)">${p.index + 1}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

/**
 * Leaflet map showing where geotagged folder images were taken.
 * Markers are numbered like the grid; highlighted images are colored
 * (amber = top pick, blue = runner-up). Clicking a marker opens that image.
 */
type BaseLayer = "street" | "satellite";

const TILES: Record<BaseLayer, { url: string; attribution: string; maxZoom: number }> = {
  street: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  },
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution:
      "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    maxZoom: 19,
  },
};

export default function FolderMap({ points, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Leaflet.Map | null>(null);
  const markerLayerRef = useRef<Leaflet.LayerGroup | null>(null);
  const baseLayerRef = useRef<Leaflet.TileLayer | null>(null);
  const leafletRef = useRef<typeof Leaflet | null>(null);
  const lastFitKeyRef = useRef("");
  const [ready, setReady] = useState(false);
  const [baseLayer, setBaseLayer] = useState<BaseLayer>("street");

  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // Init map (leaflet touches `window` at import time, so import lazily on the client)
  useEffect(() => {
    let cancelled = false;
    let observer: ResizeObserver | null = null;
    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled || !containerRef.current || mapRef.current) return;
      leafletRef.current = L;
      const map = L.map(containerRef.current, { center: [0, 0], zoom: 2 });
      const tiles = TILES.street;
      baseLayerRef.current = L.tileLayer(tiles.url, {
        attribution: tiles.attribution,
        maxZoom: tiles.maxZoom,
      }).addTo(map);
      markerLayerRef.current = L.layerGroup().addTo(map);
      mapRef.current = map;

      observer = new ResizeObserver(() => {
        // The observe() call fires an initial callback, and it can also fire
        // after teardown (StrictMode remount, or the container unmounting on
        // collapse). Touching a removed map throws on its missing panes.
        if (!cancelled && mapRef.current === map) map.invalidateSize();
      });
      observer.observe(containerRef.current);

      setReady(true);
    })();
    return () => {
      cancelled = true;
      observer?.disconnect();
      mapRef.current?.remove();
      mapRef.current = null;
      markerLayerRef.current = null;
      baseLayerRef.current = null;
      setReady(false);
    };
  }, []);

  // Swap the base tile layer when the user toggles street/satellite.
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!ready || !L || !map) return;

    baseLayerRef.current?.remove();
    const tiles = TILES[baseLayer];
    baseLayerRef.current = L.tileLayer(tiles.url, {
      attribution: tiles.attribution,
      maxZoom: tiles.maxZoom,
    }).addTo(map);
    // Keep the base tiles beneath the marker layer.
    baseLayerRef.current.bringToBack();
  }, [baseLayer, ready]);

  // (Re)render markers whenever points or highlight ranks change
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    const layer = markerLayerRef.current;
    if (!ready || !L || !map || !layer) return;

    layer.clearLayers();
    const latlngs: Leaflet.LatLngExpression[] = [];
    for (const p of points) {
      const marker = L.marker([p.lat, p.lon], {
        icon: markerIcon(L, p),
        zIndexOffset: p.rank >= 0 ? 1000 - p.rank : 0,
      }).addTo(layer);
      marker.bindTooltip(
        `Image ${p.index + 1} · ${p.name}${p.note ? ` — ${p.note}` : ""}`
      );
      marker.on("click", () => onSelectRef.current(p.index));
      latlngs.push([p.lat, p.lon]);
    }

    // Fit bounds only when the set of geotagged images changes,
    // not on every highlight update (keeps the user's pan/zoom).
    const fitKey = points.map((p) => p.index).join(",");
    if (latlngs.length > 0 && fitKey !== lastFitKeyRef.current) {
      lastFitKeyRef.current = fitKey;
      map.fitBounds(L.latLngBounds(latlngs).pad(0.25), { maxZoom: 17 });
    }
  }, [points, ready]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      <button
        type="button"
        onClick={() => setBaseLayer((v) => (v === "street" ? "satellite" : "street"))}
        className="absolute right-2 top-2 z-[1000] rounded bg-zinc-900/90 px-2 py-1 text-xs font-medium text-zinc-100 shadow ring-1 ring-zinc-700 hover:bg-zinc-800"
        title="Toggle satellite imagery"
      >
        {baseLayer === "street" ? "Satellite" : "Street"}
      </button>
    </div>
  );
}
