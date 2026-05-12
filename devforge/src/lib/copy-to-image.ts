import html2canvas from 'html2canvas';

export async function copyElementAsImage(element: HTMLElement): Promise<void> {
  const canvas = await html2canvas(element, {
    backgroundColor: '#0d1117',
    scale: 2,
    useCORS: true,
    logging: false,
    scrollX: 0,
    scrollY: -window.scrollY,
    windowWidth: document.documentElement.scrollWidth,
    windowHeight: document.documentElement.scrollHeight,
  });

  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) { reject(new Error('Failed to create image blob')); return; }
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        resolve();
      } catch {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `report-${Date.now()}.png`;
        a.click();
        URL.revokeObjectURL(url);
        resolve();
      }
    }, 'image/png');
  });
}
