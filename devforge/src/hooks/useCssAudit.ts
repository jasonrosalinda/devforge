import { CssFile, CssInstance, HtmlCss } from "@/types/cssAudits.type";
import { useMemo, useRef, useState, type SetStateAction } from "react";

export const useCssAudit = () => {
    const [cssContent, setCssContent] = useState<CssFile>(new CssFile("", ""));
    const [htmlFiles, setHtmlFiles] = useState<HtmlCss[]>([]);

    const htmlCssClasses = useMemo(() => CssInstance.merge(htmlFiles.flatMap(file => file.classes)), [htmlFiles]);

    const compareCss = useMemo(() => {
        if (!cssContent?.classes) return new CssInstance();
        return cssContent.classes.compare([htmlCssClasses]);
    }, [cssContent, htmlCssClasses]);

    const unusedCssClasses = useMemo(() => {
        if (!compareCss) return new CssInstance();
        return compareCss.unused();
    }, [compareCss]);

    const handleCSSUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (event) => {
                const content = event.target?.result as string;
                const handler = new CssFile(file.name, content);
                setCssContent(handler);
            };
            reader.readAsText(file);
        }
    };

    const handleHTMLUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files) return;

        const filePromises = Array.from(files).map(file => {
            return new Promise<HtmlCss>((resolve) => {
                const reader = new FileReader();
                reader.onload = (event) => {
                    const content = event.target?.result as string;
                    const handler = new HtmlCss(file.name, content);
                    resolve(handler);
                };
                reader.readAsText(file);
            });
        });

        Promise.all(filePromises).then(parsedFiles => {
            setHtmlFiles(prev => [...prev, ...parsedFiles]);
        });
    };

    const removeHtmlFile = (index: number) => {
        setHtmlFiles(prev => prev.filter((_, i) => i !== index));
    };

    return {
        cssContent,
        htmlFiles,
        htmlCssClasses,
        compareCss,
        unusedCssClasses,
        handleCSSUpload,
        handleHTMLUpload,
        removeHtmlFile
    };

}
