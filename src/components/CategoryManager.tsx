import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { type Category, type MuseumDocument } from '../core/model';
import { saveCategory, removeCategory } from '../core/collection';
import { Modal } from './common';

function CategoryRow({
  category,
  count,
  rename,
  remove,
}: {
  category: Category;
  count: number;
  rename: (name: string) => void;
  remove: () => void;
}) {
  const [name, setName] = useState(category.name);
  return (
    <form
      className="category-row"
      onSubmit={(e) => {
        e.preventDefault();
        rename(name);
      }}
    >
      <input
        aria-label={`Category name: ${category.name}`}
        value={name}
        maxLength={80}
        onChange={(e) => setName(e.target.value)}
      />
      <span className="tiny muted">{count} works</span>
      <button type="submit" className="secondary" disabled={name.trim() === category.name}>
        Rename
      </button>
      <button
        type="button"
        className="icon-button danger"
        aria-label={`Delete category ${category.name}`}
        onClick={remove}
      >
        <Trash2 size={15} />
      </button>
    </form>
  );
}

export default function CategoryManager({
  doc,
  change,
  onClose,
}: {
  doc: MuseumDocument;
  change: (fn: (doc: MuseumDocument) => MuseumDocument) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(''),
    [error, setError] = useState('');
  const categories = doc.categories ?? [];
  const save = (name: string, id?: string) => {
    try {
      const next = saveCategory(doc, name, id);
      change(() => next);
      setError('');
      if (!id) setName('');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title="Collection categories" wide onClose={onClose}>
      <p className="picker-intro">
        Organize works by subject, series, medium, or any grouping you prefer.
      </p>
      <form
        className="category-create"
        onSubmit={(e) => {
          e.preventDefault();
          save(name);
        }}
      >
        <label>
          New category
          <input
            value={name}
            maxLength={80}
            placeholder="e.g. Landscapes"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <button
          type="submit"
          className="primary"
          disabled={!name.trim() || categories.length >= 100}
        >
          <Plus size={15} /> Create category
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="category-list">
        {categories.map((category) => (
          <CategoryRow
            key={`${category.id}:${category.name}`}
            category={category}
            count={doc.assets.filter((a) => a.categoryIds?.includes(category.id)).length}
            rename={(name) => save(name, category.id)}
            remove={() => change((d) => removeCategory(d, category.id))}
          />
        ))}
      </div>
      {!categories.length && (
        <p className="collection-empty">
          Create your first category, then assign it in Artwork details.
        </p>
      )}
      <p className="tiny muted">
        Deleting a category keeps its artwork in your collection. A work can belong to several
        categories.
      </p>
    </Modal>
  );
}
