import { describe, expect, it } from 'vitest';
import { fitExhibit, plaqueContent } from '../src/core/exhibits';
import { compile } from '../src/core/layout';
import { museumSchema, type Region } from '../src/core/model';
import { sample } from '../src/core/sample';

const region: Region = { ...sample.regions[0], w: 4, h: 0.95 };
const title = { title: 'After the rain', explanation: '', attribution: '' };
const full = {
  ...title,
  explanation: 'A quiet landscape beside the water. '.repeat(10),
  attribution: 'The artist, 2026',
};

describe('content-sized exhibit plaques', () => {
  it('uses a compact title card and grows for explanation and attribution', () => {
    const short = plaqueContent(title, 0.9),
      long = plaqueContent(full, 0.9);
    expect(short.h).toBeLessThan(0.15);
    expect(long.h).toBeGreaterThan(short.h + 0.4);
    expect(long.lines.some((l) => l.kind === 'attribution')).toBe(true);
    for (const l of long.lines) expect(l.baseline).toBeLessThan(long.h);
  });

  it('moves the title beside horizontally split artwork to recover image height', () => {
    const auto = fitExhibit(region, 1.5, sample.defaultFrame, title);
    const below = fitExhibit(
      { ...region, plaqueAuto: false, plaque: 'below' },
      1.5,
      sample.defaultFrame,
      title,
    );
    expect(auto.fits).toBe(true);
    expect(auto.plaque!.side).toBe('right');
    expect(auto.w * auto.h).toBeGreaterThan(below.w * below.h);
    expect(auto.w / auto.h).toBeCloseTo(1.5);
  });

  it('chooses below for narrow portrait regions and keeps explicit overrides', () => {
    const narrow = { ...region, w: 1, h: 2.9 };
    const auto = fitExhibit(narrow, 0.7, sample.defaultFrame, title);
    expect(auto.fits).toBe(true);
    expect(auto.plaque!.side).toBe('below');
    expect(
      fitExhibit({ ...region, plaque: 'below', plaqueAuto: false }, 1.5, sample.defaultFrame, title)
        .plaque!.side,
    ).toBe('below');
    expect(
      fitExhibit({ ...narrow, plaque: 'right', plaqueAuto: false }, 0.7, sample.defaultFrame, title)
        .plaque!.side,
    ).toBe('right');
    expect(
      fitExhibit({ ...region, plaque: 'none' }, 1.5, sample.defaultFrame, full).plaque,
    ).toBeNull();
  });

  it('maximizes area while retaining margins, frames, mats and readable text', () => {
    for (const w of [0.7, 1.2, 2.8, 5.5])
      for (const h of [0.7, 1.4, 2.9])
        for (const aspect of [0.35, 0.7, 1, 1.5, 4])
          for (const content of [title, full]) {
            const r = { ...region, w, h };
            const frame = { ...sample.defaultFrame, mat: 0.08 };
            const auto = fitExhibit(r, aspect, frame, content);
            for (const side of ['right', 'below'] as const) {
              const fixed = fitExhibit(
                { ...r, plaque: side, plaqueAuto: false },
                aspect,
                frame,
                content,
              );
              if (fixed.fits) {
                expect(auto.fits).toBe(true);
                expect(auto.w * auto.h + 0.000001).toBeGreaterThanOrEqual(fixed.w * fixed.h);
              }
            }
            if (!auto.fits) continue;
            expect(auto.w / auto.h).toBeCloseTo(aspect);
            for (const box of [
              {
                x: auto.image.x,
                y: auto.image.y,
                w: auto.w + auto.border * 2,
                h: auto.h + auto.border * 2,
              },
              auto.plaque!,
            ]) {
              expect(box.x - box.w / 2).toBeGreaterThanOrEqual(r.x + 0.1 - 0.00001);
              expect(box.x + box.w / 2).toBeLessThanOrEqual(r.x + w - 0.1 + 0.00001);
              expect(box.y - box.h / 2).toBeGreaterThanOrEqual(r.y + 0.1 - 0.00001);
              expect(box.y + box.h / 2).toBeLessThanOrEqual(r.y + h - 0.1 + 0.00001);
            }
          }
  });

  it('keeps Unicode, long words, newlines and every title character', () => {
    const content = {
      title: '展覧会 — Étude / ' + 'W'.repeat(160),
      explanation: 'First paragraph.\n\nSecond paragraph: 日本語。',
      attribution: '',
    };
    const card = plaqueContent(content, 0.6);
    expect(
      card.lines
        .filter((l) => l.kind === 'title')
        .map((l) => l.text)
        .join('')
        .replace(/\s/g, ''),
    ).toBe(content.title.replace(/\s/g, ''));
    expect(card.lines.some((l) => !l.text && l.kind === 'explanation')).toBe(true);
    expect(card.lines.at(-1)!.baseline).toBeLessThan(card.h);
  });

  it('validates the complete card instead of silently truncating long text', () => {
    const doc = structuredClone(sample);
    doc.assets[0] = { ...doc.assets[0], ...full };
    doc.regions[0] = { ...doc.regions[0], w: 0.7, h: 0.7 };
    expect(
      compile(doc).issues.some((i) => i.code === 'fit' && i.target === doc.regions[0].id),
    ).toBe(true);
    expect(
      museumSchema.parse({ ...sample, regions: [{ ...region, plaqueAuto: false }] }).regions[0]
        .plaqueAuto,
    ).toBe(false);
    expect(museumSchema.parse(sample).regions[0].plaqueAuto).toBeUndefined();
  });
});
