import { describe, expect, it } from 'bun:test';
import { tablesFromSchema } from '../src/schema';

const record = { kind: 'record', tables: ['org'] };

describe('tablesFromSchema', () => {
	it('finds direct, optional, nested, array, set and literal links', () => {
		const tables = tablesFromSchema({
			version: 2,
			tables: [
				{
					name: 'profile',
					type: { kind: 'normal' },
					fields: [
						{ path: ['orgId'], kind: record },
						{
							path: ['nullable'],
							kind: {
								kind: 'union',
								variants: [{ kind: 'null' }, record],
							},
						},
						{ path: ['meta', 'manager'], kind: record },
						{
							path: ['members'],
							kind: { kind: 'array', item: record },
						},
						{ path: ['members', '*'], kind: record },
						{ path: ['uniq'], kind: { kind: 'set', item: record } },
						{ path: ['items', '*', 'owner'], kind: record },
						{
							path: ['lit'],
							kind: {
								kind: 'objectLiteral',
								fields: [
									{ name: 'owner', kind: record },
									{ name: 'label', kind: { kind: 'string' } },
								],
							},
						},
						{ path: ['note'], kind: { kind: 'string' } },
					],
				},
			],
		});

		expect(tables.profile).toEqual({
			name: 'profile',
			recordFields: [
				'items.owner',
				'lit.owner',
				'members',
				'meta.manager',
				'nullable',
				'orgId',
				'uniq',
			],
		});
	});

	it('marks relations and leaves in and out to the adapter', () => {
		const tables = tablesFromSchema({
			version: 2,
			tables: [
				{
					name: 'follows',
					type: { kind: 'relation' },
					fields: [
						{ path: ['in'], kind: record },
						{ path: ['out'], kind: record },
						{ path: ['by'], kind: record },
					],
				},
			],
		});
		expect(tables.follows).toEqual({
			name: 'follows',
			relation: true,
			recordFields: ['by'],
		});
	});

	it('rejects a field that can hold both a record and a string', () => {
		expect(() =>
			tablesFromSchema({
				version: 2,
				tables: [
					{
						name: 'profile',
						fields: [
							{
								path: ['mixed'],
								kind: {
									kind: 'union',
									variants: [record, { kind: 'string' }],
								},
							},
						],
					},
				],
			}),
		).toThrow('profile.mixed');
	});

	it('rejects other document versions', () => {
		expect(() => tablesFromSchema({ version: 1, tables: [] })).toThrow(
			'version 2',
		);
	});

	it('returns only names, relation flags and field paths', () => {
		const schema = {
			version: 2,
			accesses: [{ name: 'account', define: 'secret' }],
			tables: [{ name: 'user', define: 'DEFINE TABLE user', fields: [] }],
		};
		expect(JSON.stringify(tablesFromSchema(schema))).toBe(
			'{"user":{"name":"user","recordFields":[]}}',
		);
	});
});
