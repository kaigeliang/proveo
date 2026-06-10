export type PaginationParams = {
  page: number;
  pageSize: number;
  offset: number;
};

export type PaginationMeta = {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
};

function readPositiveInt(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function readPaginationParams(
  query: Record<string, unknown>,
  options: { defaultPageSize?: number; maxPageSize?: number } = {},
): PaginationParams {
  const defaultPageSize = options.defaultPageSize ?? 20;
  const maxPageSize = options.maxPageSize ?? 100;
  const page = readPositiveInt(query.page, 1);
  const pageSize = Math.min(maxPageSize, readPositiveInt(query.pageSize ?? query.limit, defaultPageSize));
  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
  };
}

export function paginationMeta(params: PaginationParams, totalItems: number): PaginationMeta {
  return {
    page: params.page,
    pageSize: params.pageSize,
    totalItems,
    totalPages: Math.max(1, Math.ceil(totalItems / params.pageSize)),
  };
}

export function paginateArray<T>(items: T[], params: PaginationParams) {
  return {
    data: items.slice(params.offset, params.offset + params.pageSize),
    pagination: paginationMeta(params, items.length),
  };
}
