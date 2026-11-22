import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createCollection, createLiveQueryCollection } from '@tanstack/db';
import { QueryClient } from '@tanstack/query-core';
import { RecordId } from 'surrealdb';

import { surrealCollectionOptions } from '../src/index';

type Thing = { id: RecordId<'thing'>; name: string };
type LiveMessage = { action: string; value: { id: RecordId } };

const rows = () => [{ id: new RecordId('thing', 'a'), name: 'A' }];

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

const setup = (notify: 'before-response' | 'after-response') => {
	let listener: ((message: LiveMessage) => unknown) | undefined;
	const emitDelete = (id: RecordId) =>
		listener?.({ action: 'DELETE', value: { id } });
	const db = {
		isFeatureSupported: () => true,
		select: async () => rows(),
		query: async () => [rows()],
		live: async () => ({
			subscribe: (next: (message: LiveMessage) => unknown) => {
				listener = next;
			},
			kill: async () => {},
		}),
		delete: async (id: RecordId) => {
			if (notify === 'before-response') await emitDelete(id);
		},
	};
	const things = createCollection(
		surrealCollectionOptions<Thing>({
			db: db as never,
			table: { name: 'thing' },
			queryClient: new QueryClient(),
			queryKey: ['thing', notify],
		}),
	);
	return { things, emitDelete };
};

describe('collection.delete with LIVE sync', () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (error: unknown) => {
		unhandled.push(error);
	};

	beforeEach(() => {
		unhandled.length = 0;
		process.on('unhandledRejection', onUnhandled);
	});
	afterEach(() => {
		process.off('unhandledRejection', onUnhandled);
	});

	for (const notify of ['before-response', 'after-response'] as const) {
		it(`applies one delete when LIVE arrives ${notify}`, async () => {
			const { things, emitDelete } = setup(notify);
			const all = createLiveQueryCollection((q) =>
				q.from({ thing: things }),
			);
			await all.preload();
			await flush();
			expect(things.has('thing:a')).toBe(true);

			await things.delete('thing:a').when('settled');
			if (notify === 'after-response') {
				await emitDelete(new RecordId('thing', 'a'));
			}
			await flush();

			expect(things.has('thing:a')).toBe(false);
			expect(unhandled).toEqual([]);
			await all.cleanup();
			await things.cleanup();
		});
	}
});
