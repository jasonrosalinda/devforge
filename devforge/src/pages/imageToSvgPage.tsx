import { AiOutlineFileImage } from "react-icons/ai";
import ImageToSvgConverter from "@/components/converters/img-to-svg-converter";
import { PageHeader } from "@/components/layout/page-header";

export default function ImageToSvgPage() {
    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                icon={AiOutlineFileImage}
                title="Image to SVG"
                subtitle="Convert raster images into optimized SVG with adjustable color count and pixel size."
            />
            <ImageToSvgConverter />
        </div>
    )
}
