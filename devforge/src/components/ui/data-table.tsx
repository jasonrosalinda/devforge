import { type ColumnDef, flexRender, getCoreRowModel, getFilteredRowModel, useReactTable } from "@tanstack/react-table"

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, } from "@/components/ui/table"
import { DataTablePagination } from "./data-table-pagination"
import { useState } from "react"
import { Separator } from "./separator"

interface DataTableProps<TData, TValue> {
    header?: (table: ReturnType<typeof useReactTable<TData>>) => React.ReactNode,
    columns: ColumnDef<TData, TValue>[]
    data: TData[],
}

export function DataTable<TData, TValue>({
    header,
    columns,
    data,
}: DataTableProps<TData, TValue>) {
    const [globalFilter, setGlobalFilter] = useState("");
    const table = useReactTable({
        data,
        columns,
        getFilteredRowModel: getFilteredRowModel(),
        state: {
            globalFilter,
        },
        onGlobalFilterChange: setGlobalFilter,
        getCoreRowModel: getCoreRowModel(),
        globalFilterFn: "includesString"
    })

    return (
        <>
            <div className="flex justify-between">
                {header?.(table)}
            </div>

            <div className="overflow-hidden rounded-md border">

                <Table>
                    <TableHeader>
                        {table.getHeaderGroups().map((headerGroup) => (
                            <TableRow key={headerGroup.id}>
                                {headerGroup.headers.map((header) => {
                                    return (
                                        <TableHead key={header.id}>
                                            {header.isPlaceholder
                                                ? null
                                                : flexRender(
                                                    header.column.columnDef.header,
                                                    header.getContext()
                                                )}
                                        </TableHead>
                                    )
                                })}
                            </TableRow>
                        ))}
                    </TableHeader>
                    <TableBody>
                        {table.getRowModel().rows?.length ? (
                            table.getRowModel().rows.map((row) => (
                                <TableRow
                                    key={row.id}
                                    data-state={row.getIsSelected() && "selected"}
                                >
                                    {row.getVisibleCells().map((cell) => (
                                        <TableCell key={cell.id}>
                                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                        </TableCell>
                                    ))}
                                </TableRow>
                            ))
                        ) : (
                            <TableRow>
                                <TableCell colSpan={columns.length} className="h-24 text-center">

                                </TableCell>
                            </TableRow>
                        )}
                    </TableBody>
                </Table>

                <Separator orientation="horizontal" className="data-[orientation=horizontal]:w-full" />

                <div className="px-2 py-5">
                    <DataTablePagination table={table} />
                </div>
            </div>
        </>
    )
}