import type { MultiPolygon, Polygon } from 'geojson';

export type BBox = [number, number, number, number];

export interface Scene {
  id: string;
  datetime: string;
  /** UTC 日期，YYYY-MM-DD */
  date: string;
  cloud: number;
  tile: string;
  bbox: BBox;
  geometry: Polygon | MultiPolygon;
}
