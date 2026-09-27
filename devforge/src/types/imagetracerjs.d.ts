// imagetracerjs ships no types. Only the one entry point the Image Converter uses.
declare module 'imagetracerjs' {
    type TraceImageData = { width: number; height: number; data: ArrayLike<number> };

    const ImageTracer: {
        /** Traces raw RGBA pixels into an SVG string. Options not given fall back to the library defaults. */
        imagedataToSVG(image: TraceImageData, options?: Record<string, unknown> | string): string;
    };

    export default ImageTracer;
}
