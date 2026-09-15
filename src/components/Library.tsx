import { useRef, useState } from 'react';
import { Upload, Search, ImagePlus, Trash2 } from 'lucide-react';
import { type MuseumDocument, type Asset } from '../core/model';
import { uploadImage } from '../lib/images';
import { Image, Modal } from './common';
export default function Library({
  doc,
  change,
}: {
  doc: MuseumDocument;
  change: (fn: (d: MuseumDocument) => MuseumDocument) => void;
}) {
  const [search, setSearch] = useState(''),
    [selected, setSelected] = useState<string | null>(null),
    [progress, setProgress] = useState(''),
    [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null),
    asset = doc.assets.find((a) => a.id === selected);
  const patch = (patch: Partial<Asset>) =>
    change((d) => ({
      ...d,
      assets: d.assets.map((a) => (a.id === selected ? { ...a, ...patch } : a)),
    }));
  async function upload(files: FileList | null) {
    if (!files) return;
    setError('');
    try {
      for (const file of Array.from(files)) {
        const asset = await uploadImage(file, setProgress);
        change((d) => ({ ...d, assets: [...d.assets, asset] }));
      }
      setProgress('');
    } catch (e) {
      setProgress('');
      setError((e as Error).message);
    }
    if (input.current) input.current.value = '';
  }
  return (
    <section className="library">
      <div className="section-heading">
        <div>
          <span className="eyebrow">YOUR COLLECTION</span>
          <h2>Artwork inventory</h2>
          <p>Manage original files, descriptions, and download permissions.</p>
        </div>
        <button
          className="primary"
          disabled={Boolean(progress)}
          onClick={() => input.current?.click()}
        >
          <Upload size={16} /> Upload artwork
        </button>
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          hidden
          onChange={(e) => void upload(e.target.files)}
        />
      </div>
      <div className="library-toolbar">
        <label className="search-input">
          <Search size={16} />
          <input
            aria-label="Search collection"
            placeholder="Find an artwork…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <span className="tiny muted">
          {doc.assets.length} artworks ·{' '}
          {(doc.assets.reduce((n, a) => n + a.bytes, 0) / 1024 / 1024).toFixed(1)} MB of originals
        </span>
      </div>
      {progress && (
        <p role="status" className="notice">
          {progress}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="art-grid">
        {doc.assets
          .filter((a) => a.title.toLowerCase().includes(search.toLowerCase()))
          .map((a) => (
            <button className="art-card" key={a.id} onClick={() => setSelected(a.id)}>
              <div className="art-thumbnail">
                <Image asset={a} />
                <span>
                  {doc.regions.filter((r) => r.assetId === a.id).length
                    ? 'On display'
                    : 'In collection'}
                </span>
              </div>
              <h3>{a.title}</h3>
              <p>
                {a.width} × {a.height}{' '}
                <span>{a.downloadable ? 'Download enabled' : 'Display only'}</span>
              </p>
            </button>
          ))}
        <button className="upload-card" onClick={() => input.current?.click()}>
          <ImagePlus size={28} />
          <strong>Add artwork</strong>
          <span>JPEG, PNG, WebP · Up to 25 MB</span>
          <span>Any aspect ratio. Always preserved.</span>
        </button>
      </div>
      {asset && (
        <Modal title="Artwork details" wide onClose={() => setSelected(null)}>
          <div className="asset-details">
            <div className="asset-detail-image">
              <Image asset={asset} size="1024" />
            </div>
            <div>
              <label>
                Title
                <input value={asset.title} onChange={(e) => patch({ title: e.target.value })} />
              </label>
              <label>
                Explanation
                <textarea
                  rows={7}
                  value={asset.explanation}
                  onChange={(e) => patch({ explanation: e.target.value })}
                />
                <small>
                  Up to 600 characters for a wall plaque. Longer text is available in the visitor
                  detail view.
                </small>
              </label>
              <label>
                Attribution
                <input
                  value={asset.attribution}
                  onChange={(e) => patch({ attribution: e.target.value })}
                />
              </label>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={asset.downloadable}
                  onChange={(e) => patch({ downloadable: e.target.checked })}
                />
                <span>
                  Allow original download
                  <small>Available only when your museum includes a gift shop.</small>
                </span>
              </label>
              <button
                className="text-button danger"
                disabled={
                  doc.regions.some((r) => r.assetId === asset.id) ||
                  doc.unplaced.some((r) => r.assetId === asset.id)
                }
                onClick={() => {
                  change((d) => ({
                    ...d,
                    assets: d.assets.filter((a) => a.id !== asset.id),
                    rooms: d.rooms.map((r) => ({
                      ...r,
                      shelves: r.shelves.filter((id) => id !== asset.id),
                    })),
                  }));
                  setSelected(null);
                }}
              >
                <Trash2 size={14} /> Remove unused artwork
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
