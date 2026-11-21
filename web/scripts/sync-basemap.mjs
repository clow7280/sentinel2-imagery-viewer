// 从本机 osm-cn-basemap 项目复制中国视角底图的样式、边界瓦片与图标，路径改写为本站地址。
// 底图矢量瓦片、地形晕渲与字体仍经后端的 /api/ofm 转发 OpenFreeMap，不随应用打包。
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

const src = process.env.OSM_CN_BASEMAP ?? `${homedir()}/repo/osm-cn-basemap`;
const out = new URL('../public/basemap/', import.meta.url);
mkdirSync(out, { recursive: true });
cpSync(`${src}/data/tiles/boundary_cn.pmtiles`, new URL('boundary_cn.pmtiles', out));
cpSync(`${src}/style/sprites`, new URL('sprites', out), { recursive: true });

const style = JSON.parse(readFileSync(`${src}/style/style.json`, 'utf8'));
style.sprite = '/basemap/sprites/ofm';
style.glyphs = '/api/ofm/fonts/{fontstack}/{range}.pbf';
const rewrite = (u) => u.replace(/^\/osm\//, '/api/ofm/').replace('pmtiles:///data/tiles/', 'pmtiles:///basemap/');
for (const source of Object.values(style.sources)) {
  if (source.url) source.url = rewrite(source.url);
  if (source.tiles) source.tiles = source.tiles.map(rewrite);
}
writeFileSync(new URL('style.json', out), JSON.stringify(style));
console.log(`已从 ${src} 同步底图到 ${out.pathname}`);
