import { useMemo, useRef, useState, type ChangeEvent } from "react";
import type { ImgToSvgConverterProps } from "@/types/img-to-svg-converter.types";

export default function useImgToSvgConverter(): ImgToSvgConverterProps {
    const [image, setImage] = useState<string | null>(null);
    const [svgData, setSvgData] = useState<string | null>(null);
    const [isProcessing, setIsProcessing] = useState<boolean>(false);
    const [colorCount, setColorCount] = useState<number>(16);
    const [pixelSize, setPixelSize] = useState<number>(4);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [imgFileName, setImgFileName] = useState<string>("");
    const svgFileName = useMemo(() => {
        return imgFileName + ".svg";
    }, [imgFileName]);

    const handleFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file && file.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = (event: ProgressEvent<FileReader>) => {
                setImage(event.target?.result as string);
                setSvgData(null);
                setImgFileName(file.name.replace(/\.[^/.]+$/, ""));
            };
            reader.readAsDataURL(file);
        }
    };

    const rgbToHex = (r: number, g: number, b: number): string => {
        return '#' + [r, g, b].map(x => {
            const hex = x.toString(16);
            return hex.length === 1 ? '0' + hex : hex;
        }).join('');
    };

    const quantizeColor = (r: number, g: number, b: number, colors: number): [number, number, number] => {
        const factor = 256 / colors;
        return [
            Math.floor(r / factor) * factor,
            Math.floor(g / factor) * factor,
            Math.floor(b / factor) * factor
        ];
    };

    const convertToSvg = async (): Promise<void> => {
        if (!image) return;

        setIsProcessing(true);

        setTimeout(async () => {
            try {
                const img = new Image();
                img.src = image;

                await new Promise<void>((resolve) => {
                    img.onload = () => resolve();
                });

                const canvas = canvasRef.current;
                if (!canvas) return;

                const ctx = canvas.getContext('2d');
                if (!ctx) return;

                const maxSize = 100;
                let width = img.width;
                let height = img.height;

                if (width > maxSize || height > maxSize) {
                    if (width > height) {
                        height = (height / width) * maxSize;
                        width = maxSize;
                    } else {
                        width = (width / height) * maxSize;
                        height = maxSize;
                    }
                }

                canvas.width = width;
                canvas.height = height;
                ctx.drawImage(img, 0, 0, width, height);

                const imageData = ctx.getImageData(0, 0, width, height);
                const data = imageData.data;

                const colorMap = new Map<string, Array<{ x: number, y: number }>>();

                for (let y = 0; y < height; y += pixelSize) {
                    for (let x = 0; x < width; x += pixelSize) {
                        const i = (y * width + x) * 4;
                        const r = data[i]!;
                        const g = data[i + 1]!;
                        const b = data[i + 2]!;
                        const a = data[i + 3]!;

                        const [qr, qg, qb] = quantizeColor(r, g, b, colorCount);

                        if (a > 128) {
                            const color = rgbToHex(qr, qg, qb);
                            if (!colorMap.has(color)) {
                                colorMap.set(color, []);
                            }
                            colorMap.get(color)?.push({ x, y });
                        }
                    }
                }

                let svgPaths = '';
                colorMap.forEach((points, color) => {
                    if (points.length > 0) {
                        const rects = points.map(p =>
                            `<rect x="${p.x}" y="${p.y}" width="${pixelSize}" height="${pixelSize}" fill="${color}"/>`
                        ).join('\n    ');
                        svgPaths += rects + '\n    ';
                    }
                });

                const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
                            <rect width="100%" height="100%" fill="white"/>
                            ${svgPaths}
                            </svg>`;

                setSvgData(svg);
            } catch (err) {
                console.error(err);
            } finally {
                setIsProcessing(false);
            }
        }, 100);
    };

    const downloadSvg = (): void => {
        if (!svgData) return;

        const blob = new Blob([svgData], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = svgFileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    return {
        colorCount,
        pixelSize,
        isProcessing,
        svgFileName,
        image,
        svgData,
        fileInputRef,
        canvasRef,
        handleFileUpload,
        convertToSvg,
        downloadSvg,
        setColorCount,
        setPixelSize
    }
}