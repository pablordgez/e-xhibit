import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { assetUrl, invalidateAssetUrl } from '../lib/storage';
import { type Asset } from '../core/model';
export function Image({
  asset,
  size = '512',
  ...props
}: { asset: Asset; size?: string } & React.ImgHTMLAttributes<HTMLImageElement>) {
  const [url, setUrl] = useState('');
  const [retry, setRetry] = useState(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const attempts = useRef(0);
  const key = size === 'original' ? asset.source : (asset.variants[size] ?? asset.variants['1024']);
  useEffect(() => {
    attempts.current = 0;
  }, [key]);
  useEffect(() => {
    let active = true;
    setUrl('');
    assetUrl(asset, size)
      .then((url) => {
        if (active) setUrl(url);
      })
      .catch(() => {
        if (active) setUrl('');
      });
    return () => {
      active = false;
      clearTimeout(retryTimer.current);
    };
  }, [key, retry]);
  return url ? (
    <img
      {...props}
      src={url}
      alt={props.alt ?? asset.title}
      loading="lazy"
      onError={(event) => {
        props.onError?.(event);
        setUrl('');
        if (attempts.current++ === 0) {
          retryTimer.current = setTimeout(() => {
            invalidateAssetUrl(asset, size);
            setRetry((value) => value + 1);
          }, 1100);
        }
      }}
    />
  ) : (
    <span className="image-missing">Image unavailable</span>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    document.exitPointerLock?.();
    dialog?.showModal();
    return () => {
      dialog?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      aria-label={title}
      className={`modal ${wide ? 'wide' : ''}`}
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        skipHtml
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          img: () => null,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
export function BookPage({
  text,
  onOverflow,
}: {
  text: string;
  onOverflow?: (overflow: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => onOverflow?.(el.scrollHeight > el.clientHeight + 1);
    const observer = new ResizeObserver(check);
    observer.observe(el);
    check();
    return () => observer.disconnect();
  }, [text, onOverflow]);
  return (
    <div ref={ref} className="book-page">
      <Markdown>{text}</Markdown>
    </div>
  );
}
