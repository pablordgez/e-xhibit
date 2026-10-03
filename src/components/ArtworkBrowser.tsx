import { Search, Check } from 'lucide-react';
import { type MuseumDocument, type Asset } from '../core/model';
import { filterArtwork } from '../core/collection';
import { Image, Modal } from './common';
import { useState } from 'react';

export function ArtworkFilters({
  doc,
  search,
  category,
  onSearch,
  onCategory,
}: {
  doc: MuseumDocument;
  search: string;
  category: string;
  onSearch: (value: string) => void;
  onCategory: (value: string) => void;
}) {
  return (
    <div className="artwork-filters">
      <label className="search-input">
        <Search size={16} aria-hidden="true" />
        <input
          aria-label="Search collection"
          placeholder="Search titles, descriptions, artists…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
      </label>
      <label className="category-filter">
        <span className="sr-only">Filter by category</span>
        <select value={category} onChange={(e) => onCategory(e.target.value)}>
          <option value="">All categories</option>
          <option value="uncategorized">Uncategorized</option>
          {(doc.categories ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export default function ArtworkPicker({
  doc,
  selected,
  onSelect,
  onClose,
  onCollection,
}: {
  doc: MuseumDocument;
  selected?: string;
  onSelect: (assetId?: string) => void;
  onClose: () => void;
  onCollection: () => void;
}) {
  const [search, setSearch] = useState(''),
    [category, setCategory] = useState('');
  const assets = filterArtwork(doc, search, category);
  return (
    <Modal title="Choose an artwork" wide onClose={onClose}>
      <p className="picker-intro">Browse your collection and select a work for this wall region.</p>
      <p className="picker-management">
        To upload new artwork or manage your images and categories, go to{' '}
        <a
          href="/admin"
          onClick={(e) => {
            e.preventDefault();
            onCollection();
          }}
        >
          Art collection ↗
        </a>
        .
      </p>
      <ArtworkFilters
        doc={doc}
        search={search}
        category={category}
        onSearch={setSearch}
        onCategory={setCategory}
      />
      <p className="tiny muted" role="status">
        {assets.length} {assets.length === 1 ? 'artwork' : 'artworks'}
      </p>
      <div className="art-grid artwork-picker-grid">
        {assets.map((a: Asset) => (
          <button
            key={a.id}
            className={`art-card picker-card ${selected === a.id ? 'chosen' : ''}`}
            aria-label={`Choose ${a.title}`}
            aria-pressed={selected === a.id}
            onClick={() => onSelect(a.id)}
          >
            <div className="art-thumbnail">
              <Image asset={a} />
              {selected === a.id && (
                <span className="picker-selected">
                  <Check size={12} /> Selected
                </span>
              )}
            </div>
            <h3>{a.title}</h3>
            <p>
              {a.width} × {a.height} px
            </p>
            {(a.categoryIds ?? []).length > 0 && (
              <div className="art-categories">
                {(doc.categories ?? [])
                  .filter((c) => a.categoryIds?.includes(c.id))
                  .map((c) => (
                    <span key={c.id}>{c.name}</span>
                  ))}
              </div>
            )}
          </button>
        ))}
      </div>
      {!assets.length && (
        <p className="collection-empty">
          {doc.assets.length
            ? 'No artworks match these filters.'
            : 'Your collection is empty. Upload your first artwork in Art collection.'}
        </p>
      )}
      <div className="picker-footer">
        <button className="text-button" onClick={() => onSelect(undefined)}>
          Leave region empty
        </button>
        <button className="secondary" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
