import type { SortModelItem } from 'ag-grid-community';
import type { SortSpec, ColumnFilter, FilterOperator } from './sql-builder';

export function adaptSortModel(sortModel: SortModelItem[]): SortSpec[] {
  return sortModel.map((s) => ({
    column: s.colId,
    direction: s.sort as 'asc' | 'desc',
  }));
}

export function adaptFilterModel(
  filterModel: Record<string, unknown>
): ColumnFilter[] {
  const filters: ColumnFilter[] = [];
  for (const [column, model] of Object.entries(filterModel)) {
    const filter = model as { type?: string; filter?: string | number };
    if (!filter.type || filter.filter === undefined) continue;
    const operator = mapAgGridFilterType(filter.type);
    if (operator) {
      filters.push({ column, operator, value: String(filter.filter) });
    }
  }
  return filters;
}

function mapAgGridFilterType(agType: string): FilterOperator | null {
  const map: Record<string, FilterOperator> = {
    equals: 'eq',
    notEqual: 'neq',
    greaterThan: 'gt',
    greaterThanOrEqual: 'gte',
    lessThan: 'lt',
    lessThanOrEqual: 'lte',
    contains: 'contains',
    startsWith: 'starts_with',
    endsWith: 'ends_with',
  };
  return map[agType] ?? null;
}
