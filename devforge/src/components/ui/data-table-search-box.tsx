import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { Table } from "@tanstack/react-table";

interface DataTableSearchBoxProps<TData> {
    table: Table<TData>;
    placeholder?: string;
    searchableColumns?: string[];
}

export function DataTableSearchBox<TData>({
    table,
    placeholder = "Search all columns...",
    searchableColumns,
}: DataTableSearchBoxProps<TData>) {
    const globalFilter = table.getState().globalFilter ?? "";

    const handleSearch = (value: string) => {
        table.setGlobalFilter(value);
    };

    const handleClear = () => {
        table.setGlobalFilter("");
    };

    return (
        <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
            <Input
                type="text"
                placeholder={placeholder}
                value={globalFilter}
                onChange={(e) => handleSearch(e.target.value)}
                className="pl-10 pr-10"
            />
            {globalFilter && (
                <Button
                    variant="ghost"
                    size="sm"
                    className="absolute right-1 top-1/2 transform -translate-y-1/2 h-7 w-7 p-0"
                    onClick={handleClear}
                >
                    <X className="h-4 w-4" />
                </Button>
            )}
        </div>
    );
}