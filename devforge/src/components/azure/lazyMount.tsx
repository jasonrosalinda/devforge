import { useEffect, useRef, useState } from 'react';

/**
 * Renders its children only once they are near the viewport.
 *
 * `content-visibility: auto` alone was not enough for the card list: it lets the browser
 * skip layout and paint for off-screen elements, but React has still mounted every one of
 * them — so each off-screen card had built its recharts SVG, registered a ResizeObserver
 * per chart, and would still re-render on state changes. This keeps them out of the tree
 * entirely until they are worth building.
 *
 * Children stay mounted once shown. Unmounting on the way out would halve the live DOM but
 * makes scrolling back up pay the full recharts mount cost again, which is the jank this
 * exists to remove.
 */
export function LazyMount({
  children,
  minHeight,
  /** Mount this far outside the viewport, so a card is ready before it scrolls in. */
  rootMargin = '600px',
  className,
}: {
  children: React.ReactNode;
  /** Reserved height before mounting, so the scrollbar does not jump as cards appear. */
  minHeight: number;
  rootMargin?: string;
  className?: string | undefined;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (shown) return;
    const el = ref.current;
    if (!el) return;

    // No IntersectionObserver (or a test environment): render rather than hide content.
    if (typeof IntersectionObserver === 'undefined') { setShown(true); return; }

    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) setShown(true);
    }, { rootMargin });
    io.observe(el);
    return () => io.disconnect();
  }, [shown, rootMargin]);

  return (
    <div
      ref={ref}
      className={className}
      style={shown
        ? undefined
        // Only reserve space while empty. Once mounted the placeholder height must go, or a
        // card shorter than the estimate keeps a gap under it forever.
        : { minHeight, contain: 'strict' }}
    >
      {shown ? children : null}
    </div>
  );
}
