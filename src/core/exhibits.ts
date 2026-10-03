import type { Asset, Frame, Region } from './model';

type Content = Pick<Asset, 'title' | 'explanation' | 'attribution'>;
export type PlaqueLine = {
  text: string;
  size: number;
  baseline: number;
  kind: 'title' | 'explanation' | 'attribution';
};
export const PLAQUE_MARGIN = 0.025;
const INSET = 0.1;
const GAP = 0.1;

// Conservative font advances keep layout deterministic in the browser and Worker.
// Rendering uses these same lines, rather than wrapping differently on each device.
function advance(char: string) {
  if (/\s/u.test(char)) return 0.35;
  if (/[ilI.,!:'`|]/u.test(char)) return 0.32;
  if (/[MW@%]/u.test(char)) return 1;
  if (/\p{Lu}/u.test(char)) return 0.78;
  if (/\p{Script=Latin}|\p{N}/u.test(char)) return 0.62;
  return 1;
}

function wrap(text: string, width: number, size: number) {
  const lines: string[] = [];
  const budget = Math.max(0.01, width) / size;
  for (const paragraph of text.trim().split(/\r?\n/)) {
    let line = '',
      used = 0;
    for (const word of paragraph.trim().split(/\s+/).filter(Boolean)) {
      const chars = Array.from(word);
      const length = chars.reduce((n, c) => n + advance(c), 0);
      if (line && used + 0.35 + length > budget) {
        lines.push(line);
        line = '';
        used = 0;
      }
      if (line) {
        line += ' ';
        used += 0.35;
      }
      for (const char of chars) {
        const next = advance(char);
        if (line && used + next > budget) {
          lines.push(line);
          line = '';
          used = 0;
        }
        line += char;
        used += next;
      }
    }
    lines.push(line);
  }
  return lines;
}

export function plaqueContent(content: Content, width: number) {
  const lines: PlaqueLine[] = [];
  let top = PLAQUE_MARGIN;
  for (const [kind, size, lineHeight] of [
    ['title', 0.043, 0.059],
    ['explanation', 0.034, 0.047],
    ['attribution', 0.029, 0.041],
  ] as const) {
    const text = content[kind].trim();
    if (!text) continue;
    if (lines.length) top += 0.025;
    for (const line of wrap(text, width - PLAQUE_MARGIN * 2, size)) {
      lines.push({ text: line, size, baseline: top + size, kind });
      top += lineHeight;
    }
  }
  return { lines, h: top + PLAQUE_MARGIN };
}

/** One physical layout shared by validation, wall elevation, and the 3D scene. */
export function fitExhibit(
  r: Region,
  aspect: number,
  frame: Frame,
  content: Content = { title: 'Artwork', explanation: '', attribution: '' },
) {
  const border = (frame.preset === 'none' ? 0 : frame.width) + frame.mat;
  const innerW = r.w - INSET * 2,
    innerH = r.h - INSET * 2;
  const candidate = (side: Region['plaque'], pw = 0) => {
    const text = side === 'none' ? { h: 0, lines: [] } : plaqueContent(content, pw);
    const availableW = innerW - (side === 'right' ? pw + GAP : 0) - border * 2;
    const availableH = innerH - (side === 'below' ? text.h + GAP : 0) - border * 2;
    const w = Math.max(0.05, Math.min(availableW, availableH * aspect)),
      h = w / aspect;
    const outerW = w + border * 2,
      outerH = h + border * 2;
    const groupW = side === 'right' ? outerW + GAP + pw : Math.max(outerW, pw);
    const groupH = side === 'below' ? outerH + GAP + text.h : Math.max(outerH, text.h);
    const left = r.x + (r.w - groupW) / 2,
      bottom = r.y + (r.h - groupH) / 2;
    const image = {
      x: side === 'right' ? left + outerW / 2 : r.x + r.w / 2,
      y: side === 'below' ? bottom + text.h + GAP + outerH / 2 : r.y + r.h / 2,
    };
    const plaque =
      side === 'none'
        ? null
        : {
            side,
            w: pw,
            h: text.h,
            x: side === 'right' ? left + outerW + GAP + pw / 2 : image.x,
            y: side === 'below' ? bottom + text.h / 2 : image.y,
            lines: text.lines,
          };
    return {
      w,
      h,
      border,
      image,
      plaque,
      fits:
        availableW > 0.2 &&
        availableH > 0.2 &&
        w > 0.15 &&
        h > 0.15 &&
        groupW <= innerW + 0.00001 &&
        groupH <= innerH + 0.00001,
    };
  };
  if (r.plaque === 'none') return candidate('none');
  const sides =
    r.plaqueAuto === false
      ? [r.plaque]
      : ([r.plaque, r.plaque === 'below' ? 'right' : 'below'] as const);
  const candidates = sides.flatMap((side) => {
    const maximum = Math.max(0.15, Math.min(innerW, side === 'right' ? 1.2 : 2));
    const widths = [
      ...new Set([0.45, 0.6, 0.75, 0.9, 1.2, maximum].map((w) => Math.min(w, maximum))),
    ];
    return widths.map((w) => candidate(side, w));
  });
  return candidates.sort((a, b) => {
    if (a.fits !== b.fits) return a.fits ? -1 : 1;
    const area = b.w * b.h - a.w * a.h;
    if (Math.abs(area) > 0.000001) return area;
    return a.plaque!.w * a.plaque!.h - b.plaque!.w * b.plaque!.h;
  })[0];
}
