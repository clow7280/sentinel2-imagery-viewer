import type { MultiPolygon, Polygon } from 'geojson';

export type BBox = [number, number, number, number];

export interface Scene {
  id: string;
  datetime: string;
  /** UTC 日期，YYYY-MM-DD */
  date: string;
  cloud: number;
  /** 缺测像元比例，百分比，分幅位于扫描带边缘时只有部分有数据 */
  nodata: number;
  /** 相对轨道号，同一轨道的各景缺测位置相同 */
  orbit: number;
  /** MGRS 分幅，如 36SXF，一位数的带号不补零 */
  tile: string;
  bbox: BBox;
  geometry: Polygon | MultiPolygon;
}
