import { ReactNode } from 'react';

export interface Column<T = any> {
  key: string;
  label: string;
  type?: 'text' | 'email' | 'number' | 'select';
  editable?: boolean;
  placeholder?: string;
  defaultValue?: any;
  sortable?: boolean;
  options?: string[];
  render?: (value: any, row: T) => ReactNode;
}

export interface RibbonButton {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'success' | 'warning' | 'danger';
  tooltip?: string;
  disabled?: boolean;
  className?: string;
  iconOnly?: boolean; // New property for icon-only buttons
}

export interface DataGridProps<T = any> {
  columns: Column<T>[];
  data: T[];
  onAdd: (newRow: Partial<T>) => void;
  onEdit: (id: number | string, updatedRow: T) => void;
  onDelete: (id: number | string) => void;
  title?: string;
  description?: string;
  enablePagination?: boolean;
  pageSize?: number;
  enableSorting?: boolean;
  ribbonButtons?: RibbonButton[];
}

export interface SortConfig {
  key: string | null;
  direction: 'asc' | 'desc' | null;
}