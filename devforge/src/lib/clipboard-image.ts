import { toast } from 'sonner';

// Copy a screenshot as a full-resolution PNG blob — paste straight into Teams
// (handled as an upload, so no clipboard-HTML size limit).
export async function copyImageToClipboard(src: string) {
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('load')); img.src = src; });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('ctx');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'));
    if (!blob) throw new Error('blob');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast.success('Image copied', { description: 'Paste into Teams (full resolution).' });
  } catch {
    toast.error('Image copy failed');
  }
}
