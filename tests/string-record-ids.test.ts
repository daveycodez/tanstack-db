import { describe, expect, it } from 'bun:test';
import {
	createCollection,
	createLiveQueryCollection,
	eq,
	inArray,
} from '@tanstack/db';
import { QueryClient } from '@tanstack/query-core';
import { RecordId, StringRecordId } from 'surrealdb';

import { surrealCollectionOptions } from '../src/index';

type User = {
	id: string;
	name: string;
	orgId: string;
	note: string;
	meta?: { manager?: string; tags?: string[] };
};

type Write = { op: string; target: string; payload?: unknown };

const serverRows = () => [
	{
		id: new RecordId('user', 'abc'),
		name: 'Alice',
		orgId: new RecordId('org', 'acme'),
		note: 'org:not-a-link',
		meta: { manager: new RecordId('user', 42), tags: ['x'] },
	},
	{
		id: new RecordId('user', '42'),
		name: 'Bob',
		orgId: new RecordId('org', 'other'),
		note: 'plain',
	},
];

const createMockDb = () => {
	const writes: Write[] = [];
	const queries: Array<{ sql: string; params: Record<string, unknown> }> =
		[];
	const db = {
		isFeatureSupported: () => false,
		select: async () => serverRows(),
		query: async (sql: string, params: Record<string, unknown>) => {
			queries.push({ sql, params });
			const rows = serverRows();
			return [sql.includes('WHERE') ? rows.slice(0, 1) : rows];
		},
		insert: async (_table: unknown, payload: Record<string, unknown>) => {
			writes.push({
				op: 'insert',
				target: String(payload.id),
				payload,
			});
			return [payload];
		},
		update: (id: unknown) => ({
			merge: async (payload: unknown) => {
				writes.push({ op: 'update', target: String(id), payload });
			},
		}),
		delete: async (id: unknown) => {
			writes.push({ op: 'delete', target: String(id) });
			expect(id).toBeInstanceOf(StringRecordId);
		},
	};
	return { db, writes, queries };
};

const createUsers = (
	db: unknown,
	syncMode: 'eager' | 'on-demand',
	queryKey: string,
) =>
	createCollection(
		surrealCollectionOptions<User>({
			db: db as never,
			table: { name: 'user' },
			queryClient: new QueryClient(),
			queryKey: ['user', queryKey],
			syncMode,
			recordIds: 'string',
			recordFields: ['orgId', 'meta.manager'],
		}),
	);

const loadAll = async (users: ReturnType<typeof createUsers>) => {
	const all = createLiveQueryCollection((q) => q.from({ user: users }));
	await all.preload();
	return all;
};

describe("recordIds: 'string'", () => {
	it('exposes record ids as lossless strings, deeply', async () => {
		const { db } = createMockDb();
		const users = createUsers(db, 'eager', 'read');
		await loadAll(users);

		expect([...users.keys()].sort()).toEqual(['user:abc', 'user:⟨42⟩']);
		const alice = users.get('user:abc');
		expect(alice).toMatchObject({
			id: 'user:abc',
			name: 'Alice',
			orgId: 'org:acme',
			note: 'org:not-a-link',
			meta: { manager: 'user:42', tags: ['x'] },
		});
	});

	it('matches eq() on plain string ids and record fields', async () => {
		const { db } = createMockDb();
		const users = createUsers(db, 'eager', 'eq');
		await loadAll(users);

		const byId = createLiveQueryCollection((q) =>
			q
				.from({ user: users })
				.where(({ user }) => eq(user.id, 'user:⟨42⟩')),
		);
		await byId.preload();
		expect(byId.toArray.map((row) => row.name)).toEqual(['Bob']);

		const byOrg = createLiveQueryCollection((q) =>
			q
				.from({ user: users })
				.where(({ user }) => eq(user.orgId, 'org:acme')),
		);
		await byOrg.preload();
		expect(byOrg.toArray.map((row) => row.name)).toEqual(['Alice']);
	});

	it('sends record ids for id and recordFields on writes', async () => {
		const { db, writes } = createMockDb();
		const users = createUsers(db, 'eager', 'write');
		await loadAll(users);

		await users.insert({
			id: 'user:new',
			name: 'Carol',
			orgId: 'org:acme',
			note: 'org:still-text',
			meta: { manager: 'user:abc' },
		}).when('settled');
		await users.update('user:abc', (draft) => {
			draft.orgId = 'org:other';
		}).when('settled');
		await users.delete('user:⟨42⟩').when('settled');

		const [insert, update, remove] = writes;
		expect(insert?.op).toBe('insert');
		const inserted = insert?.payload as Record<string, unknown>;
		expect(inserted.id).toBeInstanceOf(StringRecordId);
		expect(String(inserted.id)).toBe('user:new');
		expect(inserted.orgId).toBeInstanceOf(StringRecordId);
		expect(String(inserted.orgId)).toBe('org:acme');
		expect(inserted.note).toBe('org:still-text');
		const meta = inserted.meta as Record<string, unknown>;
		expect(meta.manager).toBeInstanceOf(StringRecordId);
		expect(String(meta.manager)).toBe('user:abc');
		expect(users.get('user:new')?.orgId).toBe('org:acme');

		expect(update?.op).toBe('update');
		expect(update?.target).toBe('user:abc');
		const merged = update?.payload as Record<string, unknown>;
		expect(merged.orgId).toBeInstanceOf(StringRecordId);
		expect(String(merged.orgId)).toBe('org:other');
		expect(merged.note).toBe('org:not-a-link');

		expect(remove).toEqual({ op: 'delete', target: 'user:⟨42⟩' });
		expect(users.has('user:⟨42⟩')).toBe(false);
	});

	it('assigns string temp ids to inserts without an id', async () => {
		const { db } = createMockDb();
		const users = createUsers(db, 'eager', 'temp');
		const schema = surrealCollectionOptions<User>({
			db: db as never,
			table: { name: 'user' },
			queryClient: new QueryClient(),
			queryKey: ['user', 'temp-schema'],
			recordIds: 'string',
		}).schema;
		const result = await schema['~standard'].validate({
			name: 'Dan',
			orgId: new RecordId('org', 'acme'),
		});
		const value = (result as { value: User }).value;
		expect(value.id.startsWith('user:')).toBe(true);
		expect(value.orgId).toBe('org:acme');
		expect(users).toBeDefined();
	});

	it('pushes down id and record field filters as record ids', async () => {
		const { db, queries } = createMockDb();
		const users = createUsers(db, 'on-demand', 'pushdown');

		const byId = createLiveQueryCollection((q) =>
			q
				.from({ user: users })
				.where(({ user }) => eq(user.id, 'user:abc')),
		);
		await byId.preload();
		expect(byId.toArray.map((row) => row.id)).toEqual(['user:abc']);

		const byOrg = createLiveQueryCollection((q) =>
			q
				.from({ user: users })
				.where(({ user }) =>
					inArray(user.orgId, ['org:acme', 'org:other']),
				),
		);
		await byOrg.preload();

		const byNote = createLiveQueryCollection((q) =>
			q
				.from({ user: users })
				.where(({ user }) => eq(user.note, 'org:not-a-link')),
		);
		await byNote.preload();

		const idQuery = queries.find((q) => q.sql.includes('WHERE (id = '));
		expect(idQuery?.sql).toContain('WHERE (id = $p0)');
		expect(idQuery?.params.p0).toBeInstanceOf(StringRecordId);
		expect(String(idQuery?.params.p0)).toBe('user:abc');

		const orgQuery = queries.find((q) => q.sql.includes('orgId IN'));
		const orgParam = orgQuery?.params.p0 as unknown[];
		expect(orgParam.map(String)).toEqual(['org:acme', 'org:other']);
		for (const value of orgParam) {
			expect(value).toBeInstanceOf(StringRecordId);
		}

		const noteQuery = queries.find((q) => q.sql.includes('note ='));
		expect(noteQuery?.params.p0).toBe('org:not-a-link');
	});

	it('keeps native RecordIds by default', async () => {
		const { db, queries } = createMockDb();
		const users = createCollection(
			surrealCollectionOptions<{
				id: RecordId;
				name: string;
				orgId: RecordId;
			}>({
				db: db as never,
				table: { name: 'user' },
				queryClient: new QueryClient(),
				queryKey: ['user', 'native'],
				syncMode: 'on-demand',
			}),
		);
		const byOrg = createLiveQueryCollection((q) =>
			q
				.from({ user: users })
				.where(({ user }) =>
					eq(user.orgId, new RecordId('org', 'acme')),
				),
		);
		await byOrg.preload();

		const row = byOrg.toArray[0];
		expect(row?.id).toBeInstanceOf(RecordId);
		expect(row?.orgId).toBeInstanceOf(RecordId);
		expect(queries[0]?.params.p0).toBeInstanceOf(RecordId);
		expect([...users.keys()]).toEqual(['user:abc']);
	});
});
