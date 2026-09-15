import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { BookPage } from '../components/common';
import { type MuseumDocument } from '../core/model';
export async function validateRenderedBooks(doc: MuseumDocument) {
  await document.fonts.ready;
  const host = document.createElement('div');
  host.style.cssText =
    'position:fixed;left:-10000px;top:0;width:250px;visibility:hidden;pointer-events:none';
  document.body.appendChild(host);
  const root = createRoot(host),
    issues: string[] = [];
  try {
    for (const room of doc.rooms.filter((r) => r.kind === 'information'))
      for (let i = 0; i < room.pages.length; i++) {
        flushSync(() => root.render(<BookPage text={room.pages[i]} />));
        const el = host.querySelector('.book-page') as HTMLElement;
        // Fixed minimum supported page box, matching the mobile authoring preview.
        el.style.height = '365px';
        if (el.scrollHeight > 367)
          issues.push(`${room.name}, page ${i + 1} overflows the mobile reading page.`);
      }
  } finally {
    root.unmount();
    host.remove();
  }
  return issues;
}
