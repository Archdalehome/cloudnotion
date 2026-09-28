/** D1 row -> API model conversions. */
import type {
  DatabaseSummary,
  FieldType,
  Member,
  Property,
  PropertyConfig,
  Role,
  RowRecord,
  RowValues,
  Share,
  ViewDef,
  ViewType,
} from '../shared/types';
import { mergeViewConfig } from '../shared/views';
import { parseJsonObject, sqlNullableString, sqlNumber, sqlString, type SqlRow } from './http';

export function propertyFromRow(row: SqlRow): Property {
  return {
    id: sqlString(row, 'id'),
    databaseId: sqlString(row, 'database_id'),
    name: sqlString(row, 'name'),
    type: sqlString(row, 'type', 'text') as FieldType,
    config: parseJsonObject<PropertyConfig>(row.config, {}),
    position: sqlNumber(row, 'position'),
    width: sqlNumber(row, 'width', 200),
    createdAt: sqlNumber(row, 'created_at'),
    updatedAt: sqlNumber(row, 'updated_at'),
  };
}

export function recordFromRow(row: SqlRow): RowRecord {
  return {
    id: sqlString(row, 'id'),
    databaseId: sqlString(row, 'database_id'),
    values: parseJsonObject<RowValues>(row.values, {}),
    position: sqlNumber(row, 'position'),
    createdBy: sqlNullableString(row, 'created_by'),
    updatedBy: sqlNullableString(row, 'updated_by'),
    createdAt: sqlNumber(row, 'created_at'),
    updatedAt: sqlNumber(row, 'updated_at'),
  };
}

export function viewFromRow(row: SqlRow): ViewDef {
  const type = sqlString(row, 'type', 'table') as ViewType;
  return {
    id: sqlString(row, 'id'),
    databaseId: sqlString(row, 'database_id'),
    name: sqlString(row, 'name'),
    type,
    config: mergeViewConfig(type, parseJsonObject(row.config, {})),
    position: sqlNumber(row, 'position'),
    createdAt: sqlNumber(row, 'created_at'),
    updatedAt: sqlNumber(row, 'updated_at'),
  };
}

export function memberFromRow(row: SqlRow): Member {
  return {
    id: sqlString(row, 'id'),
    databaseId: sqlString(row, 'database_id'),
    userId: sqlString(row, 'user_id'),
    email: sqlString(row, 'email'),
    name: sqlString(row, 'name'),
    role: sqlString(row, 'role', 'editor') as Role,
    createdAt: sqlNumber(row, 'created_at'),
  };
}

export function shareFromRow(row: SqlRow): Share {
  return {
    id: sqlString(row, 'id'),
    databaseId: sqlString(row, 'database_id'),
    token: sqlString(row, 'token'),
    permission: sqlString(row, 'permission', 'view') === 'edit' ? 'edit' : 'view',
    createdAt: sqlNumber(row, 'created_at'),
    expiresAt: row.expires_at === null || row.expires_at === undefined ? null : sqlNumber(row, 'expires_at'),
  };
}

export function databaseSummaryFromRow(row: SqlRow, role: Role): DatabaseSummary {
  return {
    id: sqlString(row, 'id'),
    name: sqlString(row, 'name'),
    icon: sqlString(row, 'icon', '📋'),
    description: sqlString(row, 'description'),
    ownerId: sqlString(row, 'owner_id'),
    ownerName: sqlNullableString(row, 'owner_name') ?? undefined,
    role,
    createdAt: sqlNumber(row, 'created_at'),
    updatedAt: sqlNumber(row, 'updated_at'),
    rowCount: row.record_count === undefined ? undefined : sqlNumber(row, 'record_count'),
  };
}
