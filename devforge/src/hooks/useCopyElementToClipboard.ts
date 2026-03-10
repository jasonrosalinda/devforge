import html2canvas from 'html2canvas';

export async function copyElementToClipboard(
    element: HTMLElement,
    options?: {
        scale?: number;
        backgroundColor?: string;
        padding?: number;
    }
): Promise<void> {
    const { scale = 2, backgroundColor = '#1a1a2e', padding = 16 } = options ?? {};

    const prevOverflow = element.style.overflow;
    const prevMaxHeight = element.style.maxHeight;
    element.style.overflow = 'visible';
    element.style.maxHeight = 'none';

    try {
        // Get the actual content height (not the full page height)
        const contentHeight = element.getBoundingClientRect().height;
        const contentWidth = element.scrollWidth;

        const canvas = await html2canvas(element, {
            scale,
            useCORS: true,
            allowTaint: true,
            backgroundColor,
            width: contentWidth + padding * 2,
            height: contentHeight + padding * 2,  // ✅ use bounding rect height, not scrollHeight
            windowWidth: contentWidth + padding * 2,
            x: -padding,
            y: -padding,
            scrollX: 0,
            scrollY: 0,
            logging: false,
        });

        // Crop canvas to actual content size (removes blank space)
        const croppedCanvas = document.createElement('canvas');
        const ctx = croppedCanvas.getContext('2d')!;
        const croppedWidth = (contentWidth + padding * 2) * scale;
        const croppedHeight = (contentHeight + padding * 2) * scale;

        croppedCanvas.width = croppedWidth;
        croppedCanvas.height = croppedHeight;
        ctx.drawImage(canvas, 0, 0, croppedWidth, croppedHeight, 0, 0, croppedWidth, croppedHeight);

        await new Promise<void>((resolve, reject) => {
            croppedCanvas.toBlob(async (blob) => {
                if (!blob) return reject(new Error('Failed to generate image blob'));
                try {
                    await navigator.clipboard.write([
                        new ClipboardItem({ 'image/png': blob }),
                    ]);
                    resolve();
                } catch (err) {
                    reject(err);
                }
            }, 'image/png');
        });

    } finally {
        element.style.overflow = prevOverflow;
        element.style.maxHeight = prevMaxHeight;
    }
}