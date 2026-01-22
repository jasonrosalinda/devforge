import { type LocalizationEntry } from "@/types/localization.types"
import { DataTable } from "@/components/ui/data-table"
import { useState, useRef } from "react";
import type { ColumnDef } from "@tanstack/react-table"
import { Button, Input } from "../ui";
import { Download, Edit2, Plus, Trash2, Upload } from "lucide-react";
import {
    AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
    AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Toast } from "@/components/ui/toast";
import {
    Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger, DialogFooter, DialogHeader
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldSet } from "../ui/field";
import { Textarea } from "@/components/ui/textarea";
import { DataTableColumnHeader } from "../ui/data-table-column-header";
import { DataTableViewOptions } from "../ui/data-table-view-options";
import { DataTableSearchBox } from "../ui/data-table-search-box";
import { useLocalizationEntry } from "@/hooks/useLocalizationEntry";

export default function LocalizationTable() {
    const { data, setData, upload, download } = useLocalizationEntry();
    const toast = Toast();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [isDialogOpen, setIsDialogOpen] = useState(false);
    const [selectedEntry, setSelectedEntry] = useState<LocalizationEntry>({
        key: "",
        en: "",
        vn: "",
        id: "",
    });
    const [errors, setErrors] = useState<Record<string, string>>({});
    const hasErrors = Object.keys(errors).length > 0;
    const [isNew, setIsNew] = useState(true);

    const onChange = (field: keyof LocalizationEntry, value: string) => {
        const updatedData = { ...selectedEntry, [field]: value };
        setSelectedEntry(updatedData);
        validateForm(updatedData);
    };

    const validateForm = (translation: LocalizationEntry) => {
        const newErrors: Record<string, string> = {};
        if (!translation.key || translation.key.trim() === "") {
            newErrors.key = "Translation key is required";
        }

        setErrors(newErrors);
        return Object.keys(newErrors).length === 0;
    }

    const onAddClick = () => {
        setIsNew(true);
        setDialogState(true);
    };

    const onEditClick = (entry: LocalizationEntry) => {
        setDialogState(true);
        setIsNew(false);
        setSelectedEntry(entry);
    };

    const onSaveClick = (entry: LocalizationEntry) => {
        const isValid = validateForm(entry);

        if (!isValid) {
            return;
        }

        if (isNew) {
            setData([...data, entry]);
        } else {
            setData(data.map(row => row.key === entry.key ? entry : row));
        }
        setDialogState(false);
    };

    const onDeleteClick = (entry: LocalizationEntry) => {
        setData(data.filter(row => row.key !== entry.key));
    };

    const onCancelClick = () => {
        setDialogState(false);
    };

    const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        try {
            toast.promise(upload(file), {
                loading: "Uploading...",
                success: "Upload successful",
                error: "Upload failed",
            });
        }
        catch (error) {
            console.error(error);
            toast.error(error instanceof Error ? error.message : String(error));
        }
    };

    const onDownloadClick = () => {
        try {
            toast.promise(download(), {
                loading: "Generating download...",
                success: "Download successful",
                error: "Download failed",
            });
        }
        catch (error) {
            console.error(error);
            toast.error(error instanceof Error ? error.message : String(error));
        }
    };

    const onUploadClick = () => {
        fileInputRef.current?.click();
    };

    const setDialogState = (open: boolean) => {
        setErrors({});
        setSelectedEntry({
            key: "",
            en: "",
            vn: "",
            id: "",
        });
        setIsDialogOpen(open);
    }

    const cellContent = (content: string) => {
        return (<p className="break-words max-w-xs">{content}</p>);
    }

    const columns: ColumnDef<LocalizationEntry>[] = [
        {
            accessorKey: "key", header: ({ column }) => (
                <DataTableColumnHeader column={column} title="Translation Key" />
            ),
            cell: ({ row }) => { return (cellContent(row.original.key)); },
        },
        {
            accessorKey: "en", header: "Value (EN)",
            cell: ({ row }) => { return (cellContent(row.original.en)); },
        },
        {
            accessorKey: "vn", header: "Value (VN)",
            cell: ({ row }) => { return (cellContent(row.original.vn)); },
        },
        {
            accessorKey: "id", header: "Value (ID)",
            cell: ({ row }) => { return (cellContent(row.original.id)); },
        },
        {
            id: "actions",
            cell: ({ row }) => {
                return (
                    <div className="flex justify-end items-center gap-2">
                        <Button
                            variant="ghost"
                            size="sm" title={`Edit ${row.original.key}`}
                            onClick={() => onEditClick(row.original)}
                        >
                            <Edit2 />
                        </Button>
                        <AlertDialog>
                            <AlertDialogTrigger asChild>
                                <Button
                                    title={`Delete ${row.original.key}`}
                                    variant="ghost"
                                    size="sm"
                                >
                                    <Trash2 />
                                </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                                <AlertDialogHeader>
                                    <AlertDialogTitle>Delete {row.original.key}?</AlertDialogTitle>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction
                                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                        onClick={() => onDeleteClick(row.original)}
                                    >
                                        Delete
                                    </AlertDialogAction>
                                </AlertDialogFooter>
                            </AlertDialogContent>
                        </AlertDialog>
                    </div>
                );
            },
        },
    ]

    return (
        <>
            <input
                ref={fileInputRef}
                type="file"
                accept=".sql"
                onChange={handleFileUpload}
                style={{ display: 'none' }}
            />

            <DataTable header={
                (table) => (
                    <div className="flex w-full items-center justify-between">
                        <div className="flex items-center gap-2">
                            <Button variant="outline" size="sm" onClick={() => onAddClick()}>
                                <Plus />
                                Add
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => onUploadClick()}>
                                <Upload />
                                Upload
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => onDownloadClick()}>
                                <Download />
                                Download
                            </Button>
                        </div>
                        <div className="flex gap-2 items-center">
                            <DataTableSearchBox table={table} placeholder="Search" />
                            <DataTableViewOptions table={table} />
                        </div>
                    </div>
                )
            } columns={columns} data={data} />

            <Dialog open={isDialogOpen} onOpenChange={setDialogState}>
                <DialogContent className="sm:max-w-xl">
                    <DialogHeader>
                        <DialogTitle>{isNew ? "Add" : "Edit"} Translation</DialogTitle>
                    </DialogHeader>

                    <FieldSet className="w-full">
                        <FieldGroup>
                            <Field data-invalid={!!errors.key} >
                                <FieldLabel htmlFor="key">Translation Key</FieldLabel>
                                <Input id="key" type="text" placeholder="Translation Key"
                                    value={selectedEntry?.key} onChange={(e) => onChange("key", e.target.value)} />
                                <FieldError>{errors.key}</FieldError>
                            </Field>
                            <Field>
                                <FieldLabel htmlFor="en">English (EN)</FieldLabel>
                                <Textarea id="en" placeholder="Value (EN)" rows={4} value={selectedEntry?.en}
                                    onChange={(e) => onChange("en", e.target.value)} />
                            </Field>
                            <Field>
                                <FieldLabel htmlFor="vn">Vietnamese (VN)</FieldLabel>
                                <Textarea id="vn" placeholder="Value (VN)" rows={4} value={selectedEntry?.vn}
                                    onChange={(e) => onChange("vn", e.target.value)} />
                            </Field>
                            <Field>
                                <FieldLabel htmlFor="id">Indonesian (ID)</FieldLabel>
                                <Textarea id="id" placeholder="Value (ID)" rows={4} value={selectedEntry?.id}
                                    onChange={(e) => onChange("id", e.target.value)} />
                            </Field>
                        </FieldGroup>
                    </FieldSet>

                    <DialogFooter>
                        <DialogClose asChild>
                            <Button variant="outline" onClick={onCancelClick}>
                                Cancel
                            </Button>
                        </DialogClose>
                        <Button type="submit" disabled={hasErrors} onClick={() => (onSaveClick(selectedEntry))}>
                            Save changes
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    )
}