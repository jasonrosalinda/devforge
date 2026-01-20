export interface ApiResponse<T> {
  data: T;
  message?: string;
  success: boolean;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ApiError {
  message: string;
  code: string;
  details?: Record<string, string[]>;
}

export type Theme = 'light' | 'dark';

export type ButtonVariant = 'primary' | 'secondary' | 'danger';

export type ButtonSize = 'small' | 'medium' | 'large';

export interface FormErrors {
  [key: string]: string;
}