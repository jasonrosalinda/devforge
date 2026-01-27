export type ImgToSvgConverterProps = {
    image: string | null;
    svgData: string | null;
    isProcessing: boolean;
    colorCount: number;
    pixelSize: number;
    svgFileName: string;
    fileInputRef: React.RefObject<HTMLInputElement | null>;
    canvasRef: React.RefObject<HTMLCanvasElement | null>;
    handleFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
    convertToSvg: () => Promise<void>;
    downloadSvg: () => void;
    setColorCount: (count: number) => void;
    setPixelSize: (size: number) => void;
}