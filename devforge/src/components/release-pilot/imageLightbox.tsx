// Release Pilot — fullscreen image zoom built on the shadcn Dialog primitive.
// Theme-token styling only (no inline hex), per codebase convention.

import { useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';

export interface LightboxImage {
  src: string;
  name: string;
}

interface ImageLightboxProps {
  image: LightboxImage | null;
  onClose: () => void;
  onCopy?: (src: string) => void;
}

// Approximate decoded byte size of a data: URI (base64 → bytes).
function dataUriBytes(src: string): number {
  const i = src.indexOf(',');
  if (!src.startsWith('data:') || i < 0) return 0;
  const b64 = src.slice(i + 1);
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(b64.length * 0.75) - padding);
}

function formatBytes(n: number): string {
  if (!n) return '';
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function formatType(src: string): string {
  const m = src.match(/^data:image\/([a-z0-9.+-]+)/i);
  return m && m[1] ? m[1].toUpperCase() : '';
}

export function ImageLightbox({ image, onClose, onCopy }: ImageLightboxProps) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => { setDims(null); }, [image]);

  const bytes = image ? dataUriBytes(image.src) : 0;
  const type = image ? formatType(image.src) : '';
  const meta = [
    dims ? `${dims.w}×${dims.h}px` : '',
    type,
    formatBytes(bytes),
  ].filter(Boolean).join('  ·  ');

  return (
    <Dialog open={!!image} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-[92vw] w-fit p-2 bg-background border-border">
        <DialogTitle className="sr-only">{image?.name ?? 'Screenshot'}</DialogTitle>
        {image && (
          <div className="flex flex-col gap-2">
            <img
              src={image.src}
              alt={image.name}
              onLoad={e => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              className="max-h-[78vh] max-w-full rounded-md object-contain"
            />
            <div className="flex flex-wrap items-center justify-between gap-2 px-1 pb-1">
              <span className="text-xs font-mono text-muted-foreground truncate">{image.name}</span>
              <div className="flex shrink-0 items-center gap-2">
                {meta && <span className="text-xs font-mono text-muted-foreground">{meta}</span>}
                {onCopy && (
                  <Hint label="Copy this screenshot at full resolution, ready to paste into Teams">
                    <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" onClick={() => onCopy(image.src)}>
                      <Copy className="h-3.5 w-3.5" /> Copy image
                    </Button>
                  </Hint>
                )}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
