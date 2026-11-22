import { type Map as MlMap, Popup } from 'maplibre-gl';

export type ClickEvent = { point: { x: number; y: number }; lngLat: { lng: number; lat: number } };

/** 弹窗：标题加若干「标签：内容」行，内容按纯文本写入 */
export function infoPopup(
  map: MlMap,
  lngLat: { lng: number; lat: number },
  title: string,
  rows: [string, string][],
  maxWidth = '320px',
) {
  const el = document.createElement('div');
  el.className = 'space-y-0.5 text-xs text-stone-700';
  const h = document.createElement('h3');
  h.className = 'mb-1 text-[13px] font-semibold text-stone-800';
  h.textContent = title;
  el.append(h);
  for (const [label, value] of rows) {
    const row = document.createElement('p');
    row.textContent = label ? `${label}：${value}` : value;
    el.append(row);
  }
  new Popup({ maxWidth }).setLngLat(lngLat).setDOMContent(el).addTo(map);
}

/** 点击位置附近指定图层中的要素 */
export function featuresAt(map: MlMap, ev: ClickEvent, layers: readonly string[], pad = 4) {
  const present = layers.filter((id) => map.getLayer(id));
  if (!present.length) return [];
  const { x, y } = ev.point;
  return map.queryRenderedFeatures(
    [
      [x - pad, y - pad],
      [x + pad, y + pad],
    ],
    { layers: present },
  );
}
