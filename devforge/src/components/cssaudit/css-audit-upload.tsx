import { useCssAudit } from "@/hooks/useCssAudit";
import { useMemo, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Trash2, Upload } from "lucide-react";
import { Input } from "../ui";
import { Label } from "@radix-ui/react-dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import CSSFileSource from "./css-file-source";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../ui/card";
import CssTableResult from "./css-table-result";
import { Table, TableBody, TableCell, TableRow } from "../ui/table";
import { Badge } from "../ui/badge";


export default function CSSAuditUpload() {
    const {
        cssContent,
        htmlFiles,
        htmlCssClasses,
        compareCss,
        unusedCssClasses,
        handleCSSUpload,
        handleHTMLUpload,
        removeHtmlFile,
    } = useCssAudit();

    const cssInputUpload = useRef<HTMLInputElement>(null);
    const htmlInputUpload = useRef<HTMLInputElement>(null);
    const htmlFileNames = useMemo(() => htmlFiles.length > 1 ? `${htmlFiles.length} files` : htmlFiles[0]?.url || "Upload HTML Files...", [htmlFiles]);

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

                <Card className="col-span-2 @container/card">
                    <CardHeader>
                        <CardTitle className="mb-5">CSS File</CardTitle>
                        <CardDescription>
                            <InputGroup>
                                <InputGroupInput value={cssContent?.name} onClick={onCssUploadClick} className="cursor-pointer" placeholder="Upload CSS File..." />
                                <InputGroupAddon align="inline-end">
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
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="h-[30vh]">
                        <CssTableResult css={compareCss ?? []}
                            badgeContent={(_className, count) => {
                                return (
                                    <>
                                        {(() => {
                                            if (count === 0) {
                                                return (
                                                    <Badge variant="destructive">Unused</Badge>
                                                )
                                            } else {
                                                return (
                                                    <Badge variant="default">{count}</Badge>
                                                )
                                            }
                                        })()}
                                    </>
                                )
                            }} />
                    </CardContent>
                </Card>

                <Card className="col-span-3 @container/card">
                    <CardHeader>
                        <CardTitle className="mb-5">HTML Files</CardTitle>
                        <CardDescription>
                            <InputGroup>
                                <InputGroupInput value={htmlFileNames} onClick={onHtmlUploadClick} className="cursor-pointer" placeholder="Upload HTML Files..." />
                                <InputGroupAddon align="inline-end">
                                    <Upload />
                                </InputGroupAddon>
                            </InputGroup>

                        </CardDescription>
                    </CardHeader>
                    <CardContent className="h-[30vh]">
                        <div className="grid grid-cols-5 gap-4 h-full">
                            <div className="col-span-2 h-full overflow-y-auto">
                                <Table className="border">
                                    <TableBody>
                                        {htmlFiles.map((file, index) => {
                                            return (
                                                <TableRow key={index} className="border">
                                                    <TableCell className="truncate max-w-40" title={file.url}>
                                                        {file.url}
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        <Button variant="ghost" size="icon"
                                                            onClick={() => removeHtmlFile(index)}>
                                                            <Trash2 />
                                                        </Button>
                                                    </TableCell>
                                                </TableRow>
                                            );
                                        })}
                                    </TableBody>
                                </Table>
                            </div>
                            <div className="col-span-3 h-full overflow-y-auto">
                                <CssTableResult css={htmlCssClasses} />
                            </div>
                        </div>
                    </CardContent>
                </Card>

            </div>

            <Card className="@container/card h-[45vh]">
                <CardHeader>Unused CSS Classes ({unusedCssClasses?.count()})</CardHeader>
                <CardContent className="h-[38vh] overflow-y-auto">
                    <CssTableResult css={unusedCssClasses ?? []} />
                </CardContent>
            </Card>
        </>
    );
}