import type { TableOptions } from './types';

type SchemaKind = {
	kind?: unknown;
	item?: SchemaKind;
	variants?: readonly SchemaKind[];
	fields?: readonly { name: string; kind: SchemaKind }[];
};

/** The part of a SurrealKit schema document (version 2) that is read here. */
export type SurrealSchemaDocument = {
	version: number;
	tables: readonly {
		name: string;
		type?: { kind?: unknown };
		fields?: readonly { path: readonly string[]; kind?: SchemaKind }[];
	}[];
};

/** A table's name, relation flag and record-link fields, safe to bundle. */
export type GeneratedTableOptions = TableOptions & {
	recordFields: readonly string[];
};

const holdsText = (kind: SchemaKind): boolean =>
	kind.kind === 'string' ||
	(kind.kind === 'union' && (kind.variants ?? []).some(holdsText));

const holdsRecord = (kind: SchemaKind): boolean =>
	kind.kind === 'record' ||
	(kind.kind === 'union' && (kind.variants ?? []).some(holdsRecord));

const collectRecordPaths = (
	kind: SchemaKind | undefined,
	path: readonly string[],
	out: Set<string>,
	table: string,
): void => {
	if (!kind) return;
	switch (kind.kind) {
		case 'record':
			out.add(path.join('.'));
			return;
		case 'union':
			if (holdsRecord(kind) && holdsText(kind)) {
				throw new Error(
					`${table}.${path.join('.')} can hold both a record and a string, which string record ids cannot tell apart.`,
				);
			}
			for (const variant of kind.variants ?? []) {
				collectRecordPaths(variant, path, out, table);
			}
			return;
		case 'array':
		case 'set':
			collectRecordPaths(kind.item, path, out, table);
			return;
		case 'objectLiteral':
			for (const field of kind.fields ?? []) {
				collectRecordPaths(
					field.kind,
					[...path, field.name],
					out,
					table,
				);
			}
			return;
	}
};

/**
 * Reads table names and record-link fields from a SurrealKit schema document
 * (`surrealkit compile`). Run it at build time and write the result to a file:
 * the document itself holds access definitions and must not reach the client.
 */
export function tablesFromSchema(
	schema: SurrealSchemaDocument,
): Record<string, GeneratedTableOptions> {
	if (schema.version !== 2) {
		throw new Error(
			`Expected a version 2 schema document (surrealkit compile), got version ${schema.version}.`,
		);
	}
	const tables: Record<string, GeneratedTableOptions> = {};
	for (const table of schema.tables) {
		const relation = table.type?.kind === 'relation';
		const paths = new Set<string>();
		for (const field of table.fields ?? []) {
			const path = field.path.filter((part) => part !== '*');
			collectRecordPaths(field.kind, path, paths, table.name);
		}
		paths.delete('id');
		if (relation) {
			paths.delete('in');
			paths.delete('out');
		}
		tables[table.name] = {
			name: table.name,
			...(relation ? { relation: true } : {}),
			recordFields: [...paths].sort(),
		};
	}
	return tables;
}
