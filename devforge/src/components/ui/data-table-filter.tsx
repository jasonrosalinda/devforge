import type { Column } from "@tanstack/react-table";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Filter } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface DataTableFilterProps<TData, TValue> {
    column: Column<TData, TValue> | undefined;
    title: string;
    options: {
        label: string;
        value: string;
        icon?: React.ComponentType<{ className?: string }>;
    }[];
}

export function DataTableFilter<TData, TValue>({
    column,
    title,
    options,
}: DataTableFilterProps<TData, TValue>) {
    const selectedValues = new Set(column?.getFilterValue() as string[]);

    if (!column) {
        return null;
    }

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-8">
                    <Filter className="mr-2 h-4 w-4" />
                    {title}
                    {selectedValues.size > 0 && (
                        <Badge variant="secondary" className="ml-2 rounded-sm px-1 font-normal">
                            {selectedValues.size}
                        </Badge>
                    )}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[200px]">
                <DropdownMenuLabel>Filter by {title.toLowerCase()}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {options.map((option) => {
                    const isSelected = selectedValues.has(option.value);
                    return (
                        <DropdownMenuCheckboxItem
                            key={option.value}
                            checked={isSelected}
                            onCheckedChange={(checked) => {
                                if (checked) {
                                    selectedValues.add(option.value);
                                } else {
                                    selectedValues.delete(option.value);
                                }
                                const filterValues = Array.from(selectedValues);
                                column.setFilterValue(
                                    filterValues.length ? filterValues : undefined
                                );
                            }}
                        >
                            {option.icon && (
                                <option.icon className="mr-2 h-4 w-4 text-muted-foreground" />
                            )}
                            <span>{option.label}</span>
                        </DropdownMenuCheckboxItem>
                    );
                })}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}