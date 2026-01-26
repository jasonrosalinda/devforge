import { useCssAudit } from "@/hooks/useCssAudit";
import { useMemo, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Trash2, Upload } from "lucide-react";
import { Input } from "../ui";
import { Label } from "@radix-ui/react-dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "../ui/input-group";
import CSSFileSource from "./css-selector";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../ui/card";
import CssTableResult from "./css-table-result";
import { Table, TableBody, TableCell, TableRow } from "../ui/table";
import { Badge } from "../ui/badge";


export default function CSSAuditUpload() {
    const {
        cssContent,
        htmlFiles,
        htmlCssClasses,
        unusedCssClasses,
        handleCSSUpload,
        handleHTMLUpload,
        removeHtmlFile,
        clearHtmlFiles
    } = useCssAudit();

    const cssInputUpload = useRef<HTMLInputElement>(null);
    const htmlInputUpload = useRef<HTMLInputElement>(null);
    const htmlFileNames = useMemo(() => htmlFiles.length > 1 ? `${htmlFiles.length} files` : htmlFiles[0]?.url || "Upload HTML Files...", [htmlFiles]);
    const hasHtmlFiles = useMemo(() => htmlFiles.length > 0, [htmlFiles]);

    const onCssUploadClick = () => {
        cssInputUpload.current?.click();
    };

    const onHtmlUploadClick = () => {
        htmlInputUpload.current?.click();
    };

    return (
        <>
            <input ref={cssInputUpload} type="file" accept=".css" onChange={handleCSSUpload} className="hidden" />

            <input ref={htmlInputUpload} type="file" accept=".html,.htm" multiple onChange={handleHTMLUpload} className="hidden" />

            <div className="grid grid-cols-5 gap-4">

                <CssTableResult
                    header={() => (
                        <InputGroup onClick={onCssUploadClick} className="cursor-pointer">
                            <InputGroupText className="p-2 text-xs font-bold">CSS File</InputGroupText>
                            <InputGroupInput readOnly value={cssContent?.name} className="cursor-pointer" placeholder="Upload CSS File..." />
                            <InputGroupAddon align="inline-end" className="cursor-pointer">
                                <>
                                    {cssContent.classes.isNotEmpty() && (
                                        <p className="text-sm text-gray-600">
                                            {cssContent.classes.count()} found
                                        </p>
                                    )}
                                </>
                                <Upload />
                            </InputGroupAddon>
                        </InputGroup>
                    )}
                    data={cssContent?.classes ?? []}
                    className="col-span-2 h-[40vh]" />

                <CssTableResult
                    header={() => (
                        <InputGroup className="cursor-pointer">
                            <InputGroupText className="p-2 text-xs font-bold" onClick={onHtmlUploadClick}>HTML Files</InputGroupText>
                            <InputGroupInput readOnly value={htmlFileNames} onClick={onHtmlUploadClick} className="cursor-pointer w-full" placeholder="Upload HTML Files..." />
                            <InputGroupAddon align="inline-end" className="cursor-pointer">
                                <Upload onClick={onHtmlUploadClick} />
                                {hasHtmlFiles && (
                                    <Trash2 onClick={clearHtmlFiles} />
                                )}
                            </InputGroupAddon>
                        </InputGroup>
                    )} data={htmlCssClasses}
                    className="col-span-3 h-[40vh]" />

            </div>

            <CssTableResult
                header={() => (
                    <Label>Unused CSS Classes ({unusedCssClasses?.count()})</Label>
                )}
                data={unusedCssClasses}
                className="h-[45vh]" />
        </>
    );
}