type SchemaKind = {
	kind?: unknown;
	item?: SchemaKind;
	variants?: readonly SchemaKind[];
	fields?: readonly { name: string; kind: SchemaKind }[];
};

/** A table from a SurrealKit schema document (`surrealkit compile`). */
export type SurrealSchemaTable = {
	name: string;
	type?: { kind?: unknown };
	fields?: readonly { path: readonly string[]; kind?: SchemaKind }[];
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

/** Reads a table's relation flag and record-link fields from SurrealKit's `tables`. */
export function schemaTableOptions(
	tables: readonly SurrealSchemaTable[],
	name: string,
): { relation: boolean; recordFields: string[] } {
	const table = tables.find((candidate) => candidate.name === name);
	if (!table) {
		throw new Error(
			`Table "${name}" is not in the provided schema tables.`,
		);
	}
	const relation = table.type?.kind === 'relation';
	const paths = new Set<string>();
	for (const field of table.fields ?? []) {
		if (!Array.isArray(field.path)) {
			throw new Error(
				'Expected tables from a version 2 schema document (surrealkit compile).',
			);
		}
		const path = field.path.filter((part) => part !== '*');
		collectRecordPaths(field.kind, path, paths, table.name);
	}
	paths.delete('id');
	if (relation) {
		paths.delete('in');
		paths.delete('out');
	}
	return { relation, recordFields: [...paths].sort() };
}
