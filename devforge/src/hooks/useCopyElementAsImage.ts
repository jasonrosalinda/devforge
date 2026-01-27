import { useCallback, useRef, useState } from "react";
import { Toast } from "@/components/ui/toast";

interface UseCopyElementAsImageOptions {
    scale?: number;
    backgroundColor?: string;
    fileNamePrefix?: string;
}

let html2CanvasLoader: Promise<any> | null = null;

const loadHtml2Canvas = () => {
    if ((window as any).html2canvas) {
        return Promise.resolve((window as any).html2canvas);
    }

    if (!html2CanvasLoader) {
        html2CanvasLoader = new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src =
                "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
            script.async = true;
            script.onload = () => resolve((window as any).html2canvas);
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }

    return html2CanvasLoader;
};

export const useCopyElementAsImage = <T extends HTMLElement>(
    options?: UseCopyElementAsImageOptions
) => {
    const {
        scale = 2,
        backgroundColor = "#020817",
        fileNamePrefix = "image",
    } = options ?? {};

    const toast = Toast();
    const elementRef = useRef<T | null>(null);
    const [isCopying, setIsCopying] = useState(false);

    const copyAsImage = useCallback(async () => {
        if (!elementRef.current || isCopying) return;

        setIsCopying(true);

        try {
            const html2canvas = await loadHtml2Canvas();

            const canvas: HTMLCanvasElement = await html2canvas(
                elementRef.current,
                {
                    backgroundColor,
                    scale,
                    logging: false,
                }
            );

            const blob = await new Promise<Blob>((resolve, reject) => {
                canvas.toBlob((b) => (b ? resolve(b) : reject()), "image/png");
            });

            if ("clipboard" in navigator && "write" in navigator.clipboard) {
                await navigator.clipboard.write([
                    new ClipboardItem({ "image/png": blob }),
                ]);
                toast.success("Copied image to clipboard");
            } else {
                throw new Error("Clipboard API not supported");
            }
        } catch (err) {
            console.error("Copy image failed:", err);

            // Fallback: download
            if (elementRef.current) {
                const html2canvas = await loadHtml2Canvas();
                const canvas = await html2canvas(elementRef.current);
                const blob = await new Promise<Blob>((resolve) =>
                    canvas.toBlob((b: Blob | PromiseLike<Blob>) => resolve(b!), "image/png")
                );

                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = url;
                link.download = `${fileNamePrefix}-${Date.now()}.png`;
                link.click();
                URL.revokeObjectURL(url);

                toast.success("Image downloaded");
            }
        } finally {
            setIsCopying(false);
        }
    }, [backgroundColor, scale, fileNamePrefix, toast, isCopying]);

    return {
        elementRef: elementRef as React.RefObject<T & any>,
        copyAsImage,
        isCopying,
    };
};
