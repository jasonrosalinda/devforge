import type { CssInfo, CssInstance } from "@/types/cssAudits.type";
import { Table, TableBody, TableCell, TableRow } from "../ui/table";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "../ui/data-table";
import { DataTableSearchBox } from "../ui/data-table-search-box";
import { DataTableColumnHeader } from "../ui/data-table-column-header";
import CssSelector from "./css-selector";
import { cn } from "@/lib/utils";

export default function CssTableResult({ data, header, className }: {
    data: CssInstance,
    header?: () => React.ReactNode,
    className?: string
}) {
    const columns: ColumnDef<CssInfo>[] = [
        {
            accessorKey: "name",
            header: ({ column }) => (
                <DataTableColumnHeader column={column} title="Class Name" />
            )
        },
        {
            accessorKey: "instances",
            header: ({ column }) => (
                <DataTableColumnHeader column={column} title="" className="justify-end" />
            ),
            cell: ({ row }) => {
                return (
                    <div className="flex justify-end items-center gap-2">
                        {row.original.instances} <CssSelector name={row.original.name} selectors={row.original.selectors} />
                    </div>
                );
            }
        }
    ];

    return (
        <div className={cn("h-full border rounded-md p-2", className)}>
            <DataTable header={
                (table) => (
                    <div className="flex w-full items-center justify-between p-2 gap-2">
                        <div className="flex items-center gap-2 w-[calc(100%-250px)]">
                            {header?.()}
                        </div>
                        <div className="flex gap-2 items-center">
                            <DataTableSearchBox table={table} placeholder="Search" />
                        </div>
                    </div>
                )
            } columns={columns} data={data.classes} />
        </div>
    )
}