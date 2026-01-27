import React, { useState, useRef, type ChangeEvent } from 'react';
import { Upload, Download, Badge, Clipboard } from 'lucide-react';
import useImgToSvgConverter from '@/hooks/useImgToSvgConverter';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../ui/card';
import { Button, Input } from '../ui';
import { Slider } from '../ui/slider';
import { Label } from '../ui/label';
import { cn } from '@/lib/utils';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupText, InputGroupTextarea } from '../ui/input-group';
import { Toast } from "@/components/ui/toast";

export default function ImageToSvgConverter() {
    const {
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
    } = useImgToSvgConverter();
    const toast = Toast();
    const onCopySvg = () => {
        if (!svgData) return;
        navigator.clipboard.writeText(svgData);
        toast.success("SVG Copied");
    }

    return (
        <div className="grid grid-cols-3 gap-4 justify-start items-start w-full">

            <Card className="col-span-1 h-[45vh]">
                <CardHeader className={cn(image ? '' : 'h-full items-center justify-center')}>
                    <div onClick={() => fileInputRef.current?.click()}
                        className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center cursor-pointer mb-4">
                        <Upload className="w-12 h-12 mx-auto mb-4 text-gray-400" />
                        <p className="text-gray-600 mb-2">Click to upload an image</p>
                        <p className="text-sm text-gray-400">PNG, JPG, GIF</p>
                        <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileUpload} className="hidden" />
                    </div>
                </CardHeader>
                <CardContent>
                    {image && (
                        <div className="grid grid-cols-6 gap-4">
                            <div className='col-span-2 flex justify-center items-center'>
                                <img src={image} alt="Uploaded" className="relative z-20 object-cover item-center" width={100} height={100} />
                            </div>

                            <div className="col-span-4 space-y-5">
                                <div>
                                    <Label>Colors: {colorCount}</Label>
                                    <Slider onValueChange={(value) => setColorCount(Number(value[0]))}
                                        value={[colorCount]} min={4} max={32} step={2} />
                                </div>

                                <div>
                                    <Label>Pixel Size: {pixelSize}px</Label>
                                    <Slider onValueChange={(value) => setPixelSize(Number(value[0]))}
                                        value={[pixelSize]} min={1} max={10} step={1} />
                                </div>

                                <Button
                                    onClick={convertToSvg}
                                    disabled={isProcessing}
                                    className="w-full disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {isProcessing ? 'Converting...' : 'Convert to SVG'}
                                </Button>
                            </div>
                        </div>
                    )}
                </CardContent>
            </Card>
            <Card className='col-span-2 pt-5 h-[45vh]'>
                <CardContent className="flex flex-col items-center justify-center h-full">
                    {svgData ? (
                        <div className="grid grid-cols-7 gap-4 w-full h-full">
                            <div className="col-span-2 flex justify-center items-center h-full w-full">
                                <div dangerouslySetInnerHTML={{ __html: svgData }} />
                            </div>
                            <div className="col-span-5">
                                <InputGroup className='h-[45vh] w-full'>
                                    <InputGroupTextarea value={svgData} className="min-h-[35vh] w-full table-scroll-area" />
                                    <InputGroupAddon align="block-start" className="border-b">
                                        <InputGroupText className="font-mono font-medium">
                                            {svgFileName}
                                        </InputGroupText>
                                        <InputGroupButton onClick={downloadSvg} className="ml-auto" size="icon-xs" title='Download SVG'>
                                            <Download />
                                        </InputGroupButton>
                                        <InputGroupButton onClick={onCopySvg} variant="ghost" size="icon-xs" title='Copy SVG'>
                                            <Clipboard />
                                        </InputGroupButton>
                                    </InputGroupAddon>
                                </InputGroup>
                            </div>
                        </div>
                    ) : (
                        <div className="text-center flex flex-col items-center justify-center py-16 text-gray-400">
                            <svg className="w-16 h-16 mx-auto mb-4 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                            </svg>
                            <p>Upload and convert an image to see the SVG output</p>
                        </div>
                    )}
                </CardContent>
            </Card>

            <canvas ref={canvasRef} className="hidden" />
        </div >

    );
}