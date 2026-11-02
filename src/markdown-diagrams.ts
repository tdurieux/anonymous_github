import { geoPath, geoMercator, geoCentroid, geoArea } from "d3-geo";
import { feature } from "topojson-client";
import type { Topology, GeometryObject } from "topojson-specification";
import type { GeoPermissibleObjects } from "d3-geo";

import type { GeoJSON } from "geojson";

const MAX_SOURCE_LENGTH = 1_000_000;
const MAX_POINTS = 60_000;

function validateMap(input: unknown, topology: boolean): void {
  let nodes = 0;
  const inspect = (value: unknown, depth = 0): void => {
    if (++nodes > 300_000 || depth > 32) throw new Error("Map complexity limit exceeded");
    if (value && typeof value === "object") for (const child of Object.values(value)) inspect(child, depth + 1);
  };
  inspect(input);
  const array = (value: unknown): unknown[] => {
    if (!Array.isArray(value)) throw new Error("Expected a map array");
    return value;
  };
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a map object");
    return value as Record<string, unknown>;
  };
  let points = 0;
  const position = (value: unknown): void => {
    const numbers = array(value);
    if (numbers.length < 2 || numbers.some(n => typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 1e100)) throw new Error("Invalid map position");
    if (++points > MAX_POINTS) throw new Error("Map point limit exceeded");
  };
  const positions = (value: unknown, depth: number): void => {
    if (depth === 0) position(value);
    else for (const child of array(value)) positions(child, depth - 1);
  };
  const root = object(input);
  let arcLengths: number[] = [];
  if (topology) {
    if (root.type !== "Topology") throw new Error("Expected Topology");
    arcLengths = array(root.arcs).map(arc => {
      const coordinates = array(arc);
      if (!coordinates.length) throw new Error("Empty topology arc");
      coordinates.forEach(position);
      return coordinates.length;
    });
    if (root.transform != null) {
      const transform = object(root.transform);
      position(transform.scale); position(transform.translate);
    }
  }
  let expandedPoints = 0;
  const arcs = (value: unknown, depth: number): void => {
    for (const child of array(value)) {
      if (depth > 0) arcs(child, depth - 1);
      else {
        if (typeof child !== "number" || !Number.isInteger(child) || child < -2147483648 || child > 2147483647) throw new Error("Invalid arc index");
        const length = arcLengths[child < 0 ? ~child : child];
        if (length === undefined) throw new Error("Missing topology arc");
        expandedPoints += Math.max(4, length);
        if (expandedPoints > MAX_POINTS) throw new Error("Topology expansion limit exceeded");
      }
    }
  };
  const geometry = (value: unknown): void => {
    const item = object(value);
    switch (item.type) {
      case "FeatureCollection": array(item.features).forEach(geometry); break;
      case "Feature": if (item.geometry != null) geometry(item.geometry); break;
      case "GeometryCollection": array(item.geometries).forEach(geometry); break;
      case "Point": position(item.coordinates); break;
      case "MultiPoint": positions(item.coordinates, 1); break;
      case "LineString": if (topology) arcs(item.arcs, 0); else positions(item.coordinates, 1); break;
      case "MultiLineString":
      case "Polygon": if (topology) arcs(item.arcs, 1); else positions(item.coordinates, 2); break;
      case "MultiPolygon": if (topology) arcs(item.arcs, 2); else positions(item.coordinates, 3); break;
      default: throw new Error("Unsupported map geometry");
    }
  };
  if (topology) Object.values(object(root.objects)).forEach(geometry);
  else geometry(root);
}

// D3's spherical polygons use the opposite winding from RFC 7946 GeoJSON.
function orientPolygons(value: GeoJSON): void {
  if (value.type === "FeatureCollection") value.features.forEach(orientPolygons);
  else if (value.type === "Feature" && value.geometry) orientPolygons(value.geometry);
  else if (value.type === "GeometryCollection") value.geometries.forEach(orientPolygons);
  else if (value.type === "Polygon" || value.type === "MultiPolygon") {
    const polygons = value.type === "Polygon" ? [value.coordinates] : value.coordinates;
    for (const polygon of polygons) polygon.forEach((ring, index) => {
      const large = geoArea({ type: "Polygon", coordinates: [ring] }) > 2 * Math.PI;
      if (large === (index === 0)) ring.reverse();
    });
  }
}

type Vertex = [number, number, number];
export function stlPaths(vertices: Vertex[], angle = 0.6): string {
  const points = vertices.map(([x, y, z]) => {
    const u = x * Math.cos(angle) - z * Math.sin(angle);
    const depth = x * Math.sin(angle) + z * Math.cos(angle);
    return [u, -y * Math.cos(0.45) + depth * Math.sin(0.45), depth];
  });
  const bounds = points.reduce((b, p) => [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])], [Infinity, Infinity, -Infinity, -Infinity]);
  const scale = 260 / (Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]) || 1);
  const triangles: { depth: number; path: string }[] = [];
  for (let i = 0; i < points.length; i += 3) {
    const triangle = points.slice(i, i + 3);
    const coordinates = triangle.map(p => `${(320 + (p[0] - (bounds[0] + bounds[2]) / 2) * scale).toFixed(3)},${(160 + (p[1] - (bounds[1] + bounds[3]) / 2) * scale).toFixed(3)}`);
    triangles.push({ depth: triangle.reduce((sum, p) => sum + p[2], 0), path: `<path d="M${coordinates.join("L")}Z"/>` });
  }
  return triangles.sort((a, b) => a.depth - b.depth).map(t => t.path).join("");
}

export function renderDiagram(source: string, language: string): string {
  if (source.length > MAX_SOURCE_LENGTH) throw new Error("Diagram source limit exceeded");
  let paths: string;
  let data = "";
  if (language === "stl") {
    if (!/^\s*solid\b/.test(source) || !/\bendsolid\b/.test(source)) throw new Error("Invalid ASCII STL");
    const vertices: Vertex[] = [...source.matchAll(/\bvertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/g)].map(match => match.slice(1).map(Number) as Vertex);
    if (!vertices.length || vertices.length % 3 || vertices.length > 60000 || vertices.some(v => v.some(n => !Number.isFinite(n) || Math.abs(n) > 1e100))) throw new Error("Invalid STL vertices");
    paths = stlPaths(vertices);
    data = ` data-vertices="${JSON.stringify(vertices)}"`;
  } else {
    const input = JSON.parse(source);
    validateMap(input, language === "topojson");
    const geometry = language === "topojson"
      ? { type: "FeatureCollection", features: Object.values((input as Topology).objects).flatMap(object => {
        const converted = feature(input as Topology, object as GeometryObject);
        return converted.type === "FeatureCollection" ? converted.features : [converted];
      }) }
      : input;
    if (language === "topojson") validateMap(geometry, false);
    orientPolygons(geometry);
    const projection = geoMercator().fitExtent([[20, 20], [620, 300]], geometry as GeoPermissibleObjects);
    // A lone point has zero extent; center it at a useful finite scale.
    if (!Number.isFinite(projection.scale())) projection.scale(100).center(geoCentroid(geometry as GeoPermissibleObjects)).translate([320, 160]);
    const path = geoPath(projection).pointRadius(5)(geometry as GeoPermissibleObjects);
    if (!path || /NaN|Infinity/.test(path)) throw new Error("Invalid map geometry");
    paths = `<path d="${path}"/>`;
  }
  const label = language === "stl" ? "3D model" : "Map";
  return `<figure class="markdown-diagram" data-diagram="${language}"${data}><svg viewBox="0 0 640 320" role="img" aria-label="${label}"><g>${paths}</g></svg><figcaption>${label}</figcaption><div class="diagram-controls"><button type="button" data-diagram-action="in" aria-label="Zoom in">+</button><button type="button" data-diagram-action="out" aria-label="Zoom out">−</button>${language === "stl" ? '<button type="button" data-diagram-action="rotate">Rotate</button>' : ''}<button type="button" data-diagram-action="reset">Reset</button></div></figure>`;
}
