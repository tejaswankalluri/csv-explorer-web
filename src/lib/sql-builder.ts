export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'starts_with'
  | 'ends_with'
  | 'is_null'
  | 'is_not_null';

export interface ColumnFilter {
  column: string;
  operator: FilterOperator;
  value: string;
}

export interface SortSpec {
  column: string;
  direction: 'asc' | 'desc';
}

export interface QueryState {
  tableName: string;
  filters: ColumnFilter[];
  sort: SortSpec[];
  search: string;
  searchColumns: string[];
  offset: number;
  limit: number;
}

export interface BuiltQuery {
  dataSql: string;
  countSql: string;
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function escapeString(value: string): string {
  return value
    .replace(/'/g, "''")
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

function buildFilterClause(filter: ColumnFilter): string | null {
  const col = quoteIdentifier(filter.column);
  const val = escapeString(filter.value);

  switch (filter.operator) {
    case 'eq':
      return `${col} = '${val}'`;
    case 'neq':
      return `${col} != '${val}'`;
    case 'gt':
      return `${col} > '${val}'`;
    case 'gte':
      return `${col} >= '${val}'`;
    case 'lt':
      return `${col} < '${val}'`;
    case 'lte':
      return `${col} <= '${val}'`;
    case 'contains':
      return `${col} ILIKE '%${val}%'`;
    case 'starts_with':
      return `${col} ILIKE '${val}%'`;
    case 'ends_with':
      return `${col} ILIKE '%${val}'`;
    case 'is_null':
      return `${col} IS NULL`;
    case 'is_not_null':
      return `${col} IS NOT NULL`;
    default:
      return null;
  }
}

function buildSearchClause(column: string, search: string): string {
  const escapedSearch = escapeString(search);
  return `CAST(${quoteIdentifier(column)} AS VARCHAR) ILIKE '%${escapedSearch}%'`;
}

export function buildQuery(state: QueryState): BuiltQuery {
  const { tableName, filters, sort, search, searchColumns, offset, limit } = state;

  const table = quoteIdentifier(tableName);
  const whereClauses: string[] = [];

  for (const filter of filters) {
    const clause = buildFilterClause(filter);
    if (clause) whereClauses.push(clause);
  }

  if (search.trim() && searchColumns.length > 0) {
    const normalizedSearch = search.trim();
    const searchClauses = searchColumns.map((col) =>
      buildSearchClause(col, normalizedSearch)
    );
    whereClauses.push(`(${searchClauses.join(' OR ')})`);
  }

  const safeLimit = Math.max(0, Math.floor(limit) || 100);
  const safeOffset = Math.max(0, Math.floor(offset) || 0);

  const whereStr = whereClauses.length > 0
    ? `WHERE ${whereClauses.join(' AND ')}`
    : '';

  const orderStr = sort.length > 0
    ? `ORDER BY ${sort.map((s) => `${quoteIdentifier(s.column)} ${s.direction.toUpperCase()}`).join(', ')}`
    : '';

  const dataSql = [
    `SELECT * FROM ${table}`,
    whereStr,
    orderStr,
    `LIMIT ${safeLimit} OFFSET ${safeOffset}`,
  ].filter(Boolean).join(' ');

  const countSql = [
    `SELECT COUNT(*)::INTEGER AS cnt FROM ${table}`,
    whereStr,
  ].filter(Boolean).join(' ');

  return { dataSql, countSql };
}
