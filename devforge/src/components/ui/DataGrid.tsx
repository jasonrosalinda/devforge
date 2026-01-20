import { useState, useMemo, ChangeEvent, ReactNode } from "react";
import { useConfirm } from '../../contexts/ConfirmDialogContext';

import {
  Edit2,
  Trash2,
  Plus,
  Save,
  X,
  ChevronLeft,
  ChevronRight,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
} from "lucide-react";

// Import types from the types file
import { Column, RibbonButton, SortConfig } from '../../types/DataGrid.types';

// Additional types not in DataGrid.types
interface RowAction<T> {
  label: string;
  icon?: ReactNode;
  onClick: (row: T) => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'success' | 'warning';
  disabled?: boolean | ((row: T) => boolean);
  hidden?: boolean | ((row: T) => boolean);
  tooltip?: string;
}

interface DataGridProps<T extends { id: number | string }> {
  columns: Column<T>[];
  data: T[];
  onAdd?: (newRow: Partial<T>) => void;
  onEdit?: (id: number | string, updatedRow: T) => void;
  onDelete?: (id: number | string) => void;
  title?: string;
  description?: string;
  enablePagination?: boolean;
  pageSize?: number;
  enableSorting?: boolean;
  ribbonButtons?: RibbonButton[];
  rowActions?: RowAction<T>[];
  showDefaultActions?: {
    add?: boolean;
    edit?: boolean;
    delete?: boolean;
  };
  emptyMessage?: string;
}

export default function DataGrid<T extends { id: number | string }>({
  columns,
  data,
  onAdd,
  onEdit,
  onDelete,
  title = "",
  description = "",
  enablePagination = true,
  pageSize = 10,
  enableSorting = true,
  ribbonButtons = [],
  rowActions = [],
  showDefaultActions = { add: true, edit: true, delete: true },
  emptyMessage = "No data available"
}: DataGridProps<T>) {
  const [editingId, setEditingId] = useState<number | string | null>(null);
  const [editForm, setEditForm] = useState<Partial<T>>({});
  const [isAdding, setIsAdding] = useState(false);
  const [newForm, setNewForm] = useState<Partial<T>>({});
  const { confirm } = useConfirm();

  // Pagination states
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(pageSize);

  // Sorting states
  const [sortConfig, setSortConfig] = useState<SortConfig>({
    key: null,
    direction: null,
  });

  // Check if any default actions are enabled
  const hasDefaultActions = showDefaultActions.edit || showDefaultActions.delete;
  const hasAnyActions = hasDefaultActions || rowActions.length > 0;
  
  // Check if any column is editable
  const hasEditableColumns = useMemo(() => {
    return columns.some(col => {
      if (typeof col.editable === 'function') {
        return true; // If it's a function, it can be editable for some rows
      }
      return col.editable === true;
    });
  }, [columns]);

  // Check if a specific column is editable for a row
  const isColumnEditable = (column: Column<T>, row: T): boolean => {
    if (typeof column.editable === 'function') {
      return column.editable(row);
    }
    return column.editable === true;
  };

  // Check if a row has any editable columns
  const rowHasEditableColumns = (row: T): boolean => {
    return columns.some(col => isColumnEditable(col, row));
  };

  // Sort data
  const sortedData = useMemo(() => {
    if (!enableSorting || !sortConfig.key) {
      return [...data];
    }

    const sorted = [...data].sort((a, b) => {
      const aValue = (a as any)[sortConfig.key!];
      const bValue = (b as any)[sortConfig.key!];

      if (aValue == null) return 1;
      if (bValue == null) return -1;

      if (typeof aValue === "string" && typeof bValue === "string") {
        return sortConfig.direction === "asc"
          ? aValue.localeCompare(bValue)
          : bValue.localeCompare(aValue);
      }

      if (typeof aValue === "number" && typeof bValue === "number") {
        return sortConfig.direction === "asc"
          ? aValue - bValue
          : bValue - aValue;
      }

      return sortConfig.direction === "asc"
        ? String(aValue).localeCompare(String(bValue))
        : String(bValue).localeCompare(String(aValue));
    });

    return sorted;
  }, [data, sortConfig, enableSorting]);

  // Calculate pagination
  const totalPages = Math.ceil(sortedData.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedData = enablePagination
    ? sortedData.slice(startIndex, endIndex)
    : sortedData;

  // Reset to first page when data changes
  const handleDataChange = () => {
    if (currentPage > totalPages && totalPages > 0) {
      setCurrentPage(totalPages);
    }
  };

  // Handle column sorting
  const handleSort = (columnKey: string) => {
    if (!enableSorting) return;

    const column = columns.find((col) => col.key === columnKey);
    if (column && column.sortable === false) return;

    let direction: "asc" | "desc" = "asc";

    if (sortConfig.key === columnKey) {
      if (sortConfig.direction === "asc") {
        direction = "desc";
      } else if (sortConfig.direction === "desc") {
        setSortConfig({ key: null, direction: null });
        return;
      }
    }

    setSortConfig({ key: columnKey, direction });
    setCurrentPage(1);
  };

  // Get sort icon for column
  const getSortIcon = (columnKey: string) => {
    if (!enableSorting) return null;

    const column = columns.find((col) => col.key === columnKey);
    if (column && column.sortable === false) return null;

    if (sortConfig.key === columnKey) {
      return sortConfig.direction === "asc" ? (
        <ArrowUp size={16} className="text-blue-600" />
      ) : (
        <ArrowDown size={16} className="text-blue-600" />
      );
    }
    return <ArrowUpDown size={16} className="text-gray-400" />;
  };

  // Initialize new form with default values from columns
  const initializeNewForm = (): Partial<T> => {
    const form: any = {};
    columns.forEach((col) => {
      const isEditable = typeof col.editable === 'function' ? true : col.editable;
      if (isEditable) {
        form[col.key] = col.defaultValue !== undefined ? col.defaultValue : "";
      }
    });
    return form;
  };

  // Start editing a row
  const handleEditRow = (row: T) => {
    setEditingId(row.id);
    setEditForm({ ...row });
  };

  // Save edited row
  const handleSave = () => {
    if (editingId !== null && onEdit) {
      onEdit(editingId, editForm as T);
      setEditingId(null);
      setEditForm({});
    }
  };

  // Cancel editing
  const handleCancel = () => {
    setEditingId(null);
    setEditForm({});
  };

  // Delete a row
  const handleDeleteRow = async (id: number | string) => {
    const confirmed = await confirm({
      title: title,
      message: 'Are you sure you want to delete this row?',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'danger'
    });

    if (confirmed && onDelete) {
      onDelete(id);
      handleDataChange();
    }
  };

  // Add new row
  const handleAddNew = () => {
    if (onAdd) {
      onAdd(newForm);
      setNewForm(initializeNewForm());
      setIsAdding(false);
      if (enablePagination) {
        const newTotalPages = Math.ceil((data.length + 1) / itemsPerPage);
        setCurrentPage(newTotalPages);
      }
    }
  };

  // Cancel adding new row
  const handleCancelAdd = () => {
    setNewForm(initializeNewForm());
    setIsAdding(false);
  };

  // Open add form
  const handleOpenAdd = () => {
    setNewForm(initializeNewForm());
    setIsAdding(true);
  };

  // Pagination handlers
  const goToPage = (page: number) => {
    setCurrentPage(Math.max(1, Math.min(page, totalPages)));
  };

  const handleItemsPerPageChange = (value: string) => {
    setItemsPerPage(Number(value));
    setCurrentPage(1);
  };

  // Get button variant classes
  const getButtonVariant = (variant?: string): string => {
    switch (variant) {
      case 'danger':
        return 'text-red-600 hover:bg-red-100';
      case 'success':
        return 'text-green-600 hover:bg-green-100';
      case 'warning':
        return 'text-yellow-600 hover:bg-yellow-100';
      case 'secondary':
        return 'text-gray-600 hover:bg-gray-100';
      default:
        return 'text-blue-600 hover:bg-blue-100';
    }
  };

  // Check if action button should be disabled
  const isActionDisabled = (action: RowAction<T>, row: T): boolean => {
    if (typeof action.disabled === 'function') {
      return action.disabled(row);
    }
    return action.disabled || false;
  };

  // Check if action button should be hidden
  const isActionHidden = (action: RowAction<T>, row: T): boolean => {
    if (typeof action.hidden === 'function') {
      return action.hidden(row);
    }
    return action.hidden || false;
  };

  // Render input field based on column type
  const renderInput = (
    column: Column<T>,
    value: any,
    onChange: (key: string, val: any) => void,
  ) => {
    const commonClasses =
      "w-full px-3 py-1 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500";

    switch (column.type) {
      case "select":
        return (
          <select
            value={value || ""}
            onChange={(e: ChangeEvent<HTMLSelectElement>) =>
              onChange(column.key, e.target.value)
            }
            className={commonClasses}
          >
            {column.options?.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        );
      case "email":
        return (
          <input
            type="email"
            value={value || ""}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              onChange(column.key, e.target.value)
            }
            className={commonClasses}
            placeholder={column.placeholder}
          />
        );
      case "number":
        return (
          <input
            type="number"
            value={value || ""}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              onChange(column.key, e.target.value)
            }
            className={commonClasses}
            placeholder={column.placeholder}
          />
        );
      default:
        return (
          <input
            type="text"
            value={value || ""}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              onChange(column.key, e.target.value)
            }
            className={commonClasses}
            placeholder={column.placeholder}
          />
        );
    }
  };

  // Render cell value with custom rendering if provided
  const renderCell = (column: Column<T>, row: T) => {
    if (column.render) {
      return column.render((row as any)[column.key], row);
    }
    return (
      <span className="text-sm text-gray-900">{(row as any)[column.key]}</span>
    );
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      {(title || description) && (
        <div className="flex justify-between items-center">
          <div>
            {title && <h2 className="text-2xl font-bold text-gray-800">{title}</h2>}
            {description && <p className="text-gray-600 mt-1">{description}</p>}
          </div>
        </div>
      )}

      <div className="bg-white rounded-lg shadow overflow-hidden">
        {/* Ribbon/Menu Buttons */}
        {(showDefaultActions.add || ribbonButtons.length > 0) && (
          <div className="bg-gray-900 shadow p-3">
            <div className="flex items-center gap-2 flex-wrap">
              {/* Add New Button */}
              {showDefaultActions.add && onAdd && (
                <button
                  onClick={handleOpenAdd}
                  className="flex items-center gap-2 p-2 text-white rounded-lg transition-colors"
                  title="Add New"
                >
                  <Plus size={18} />
                </button>
              )}

              {/* Separator */}
              {showDefaultActions.add && ribbonButtons.length > 0 && (
                <div className="h-8 w-px bg-gray-300 mx-2"></div>
              )}

              {/* Custom Ribbon Buttons */}
              {ribbonButtons.map((button, index) => {
                // Icon-only button (no label)
                if (button.iconOnly) {
                  return (
                    <button
                      key={index}
                      onClick={button.onClick}
                      className={`p-2 rounded-lg transition-colors text-white ${button.className || ""}`}
                      disabled={button.disabled}
                      title={button.tooltip}
                    >
                      {button.icon}
                    </button>
                  );
                }

                // Regular button with icon and label
                return (
                  <button
                    key={index}
                    onClick={button.onClick}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                      button.variant === "danger"
                        ? "bg-red-600 text-white hover:bg-red-700"
                        : button.variant === "success"
                          ? "bg-green-600 text-white hover:bg-green-700"
                          : button.variant === "warning"
                            ? "bg-yellow-500 text-white hover:bg-yellow-600"
                            : button.variant === "secondary"
                              ? "bg-gray-600 text-white hover:bg-gray-700"
                              : "bg-blue-600 text-white hover:bg-blue-700"
                    } ${button.className || ""}`}
                    disabled={button.disabled}
                    title={button.tooltip}
                  >
                    {button.icon}
                    {button.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Table */}
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={`px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider ${
                    enableSorting && col.sortable !== false
                      ? "cursor-pointer select-none hover:bg-gray-100"
                      : ""
                  }`}
                  onClick={() => handleSort(col.key)}
                >
                  <div className="flex items-center gap-2">
                    {col.label}
                    {enableSorting &&
                      col.sortable !== false &&
                      getSortIcon(col.key)}
                  </div>
                </th>
              ))}
              {hasAnyActions && (
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              )}
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {/* Add New Row Form */}
            {isAdding && (
              <tr className="bg-blue-50">
                {columns.map((col) => {
                  const isEditable = typeof col.editable === 'function' ? true : col.editable;
                  return (
                    <td key={col.key} className="px-6 py-4">
                      {isEditable ? (
                        renderInput(col, (newForm as any)[col.key], (key, val) =>
                          setNewForm({ ...newForm, [key]: val }),
                        )
                      ) : (
                        <span className="text-sm text-gray-400">Auto</span>
                      )}
                    </td>
                  );
                })}
                {hasAnyActions && (
                  <td className="px-6 py-4">
                    <div className="flex gap-2">
                      <button
                        onClick={handleAddNew}
                        className="p-1 text-green-600 hover:bg-green-100 rounded transition-colors"
                        title="Save"
                      >
                        <Save size={18} />
                      </button>
                      <button
                        onClick={handleCancelAdd}
                        className="p-1 text-gray-600 hover:bg-gray-100 rounded transition-colors"
                        title="Cancel"
                      >
                        <X size={18} />
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            )}

            {/* Data Rows */}
            {paginatedData.map((row) => (
              <tr
                key={row.id}
                className={
                  editingId === row.id ? "bg-yellow-50" : "hover:bg-gray-50"
                }
              >
                {columns.map((col) => (
                  <td key={col.key} className="px-6 py-4 whitespace-nowrap">
                    {editingId === row.id && isColumnEditable(col, row)
                      ? renderInput(
                          col,
                          (editForm as any)[col.key],
                          (key, val) =>
                            setEditForm({ ...editForm, [key]: val }),
                        )
                      : renderCell(col, row)}
                  </td>
                ))}
                {hasAnyActions && (
                  <td className="px-6 py-4 whitespace-nowrap text-sm">
                    {editingId === row.id ? (
                      <div className="flex gap-2">
                        <button
                          onClick={handleSave}
                          className="p-1 text-green-600 hover:bg-green-100 rounded transition-colors"
                          title="Save"
                        >
                          <Save size={18} />
                        </button>
                        <button
                          onClick={handleCancel}
                          className="p-1 text-gray-600 hover:bg-gray-100 rounded transition-colors"
                          title="Cancel"
                        >
                          <X size={18} />
                        </button>
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        {/* Default Edit Button */}
                        {showDefaultActions.edit && onEdit && hasEditableColumns && rowHasEditableColumns(row) && (
                          <button
                            onClick={() => handleEditRow(row)}
                            className="p-1 text-blue-600 hover:bg-blue-100 rounded transition-colors"
                            title="Edit"
                          >
                            <Edit2 size={18} />
                          </button>
                        )}

                        {/* Default Delete Button */}
                        {showDefaultActions.delete && onDelete && (
                          <button
                            onClick={() => handleDeleteRow(row.id)}
                            className="p-1 text-red-600 hover:bg-red-100 rounded transition-colors"
                            title="Delete"
                          >
                            <Trash2 size={18} />
                          </button>
                        )}

                        {/* Custom Row Actions */}
                        {rowActions.map((action, index) => {
                          if (isActionHidden(action, row)) return null;

                          return (
                            <button
                              key={index}
                              onClick={() => action.onClick(row)}
                              disabled={isActionDisabled(action, row)}
                              className={`p-1 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${getButtonVariant(action.variant)}`}
                              title={action.tooltip || action.label}
                            >
                              {action.icon || <span className="text-xs">{action.label}</span>}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>

        {/* Empty State */}
        {data.length === 0 && !isAdding && (
          <div className="text-center py-12">
            <p className="text-gray-500 text-lg">{emptyMessage}</p>
            {showDefaultActions.add && onAdd && (
              <p className="text-gray-400 text-sm mt-2">
                Click "Add New" to create your first entry
              </p>
            )}
          </div>
        )}
      </div>

      {/* Pagination and Summary */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="flex items-center justify-between flex-wrap gap-4">
          {/* Summary */}
          <div className="flex items-center gap-6">
            <p className="text-sm text-gray-600">
              Total Records:{" "}
              <span className="font-semibold text-gray-800">{data.length}</span>
            </p>

            {/* Items per page selector */}
            {enablePagination && (
              <div className="flex items-center gap-2">
                <label className="text-sm text-gray-600">Show:</label>
                <select
                  value={itemsPerPage}
                  onChange={(e) => handleItemsPerPageChange(e.target.value)}
                  className="px-3 py-1 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                >
                  <option value="5">5</option>
                  <option value="10">10</option>
                  <option value="25">25</option>
                  <option value="50">50</option>
                  <option value="100">100</option>
                </select>
                <span className="text-sm text-gray-600">per page</span>
              </div>
            )}
          </div>

          {/* Pagination Controls */}
          {enablePagination && totalPages > 1 && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-600 mr-2">
                Page {currentPage} of {totalPages}
              </span>

              <button
                onClick={() => goToPage(1)}
                disabled={currentPage === 1}
                className="px-3 py-1 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
              >
                First
              </button>

              <button
                onClick={() => goToPage(currentPage - 1)}
                disabled={currentPage === 1}
                className="p-1 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <ChevronLeft size={20} />
              </button>

              {/* Page Numbers */}
              <div className="flex gap-1">
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  let pageNum: number;
                  if (totalPages <= 5) {
                    pageNum = i + 1;
                  } else if (currentPage <= 3) {
                    pageNum = i + 1;
                  } else if (currentPage >= totalPages - 2) {
                    pageNum = totalPages - 4 + i;
                  } else {
                    pageNum = currentPage - 2 + i;
                  }

                  return (
                    <button
                      key={pageNum}
                      onClick={() => goToPage(pageNum)}
                      className={`px-3 py-1 border rounded text-sm ${
                        currentPage === pageNum
                          ? "bg-blue-600 text-white border-blue-600"
                          : "border-gray-300 hover:bg-gray-50"
                      }`}
                    >
                      {pageNum}
                    </button>
                  );
                })}
              </div>

              <button
                onClick={() => goToPage(currentPage + 1)}
                disabled={currentPage === totalPages}
                className="p-1 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <ChevronRight size={20} />
              </button>

              <button
                onClick={() => goToPage(totalPages)}
                disabled={currentPage === totalPages}
                className="px-3 py-1 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
              >
                Last
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}