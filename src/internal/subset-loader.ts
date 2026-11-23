import type { LoadSubsetOptions } from '@tanstack/db';
import { CancelledError, type QueryClient } from '@tanstack/query-core';
import {
	CallTerminatedError,
	ConnectionUnavailableError,
	HttpConnectionError,
	UnexpectedConnectionError,
} from 'surrealdb';
import type { SubsetRetryOptions } from '../types';

type Row = Record<string, unknown>;

const DEFAULT_CONNECTION_RETRIES = 3;

const isConnectionLoss = (error: unknown): boolean =>
	error instanceof CallTerminatedError ||
	error instanceof ConnectionUnavailableError ||
	error instanceof HttpConnectionError ||
	error instanceof UnexpectedConnectionError;

type SubsetLoaderConfig = SubsetRetryOptions & {
	queryClient: QueryClient;
	queryKey: readonly unknown[];
	load: (subset: LoadSubsetOptions) => Promise<Row[]>;
};

/**
 * Runs subset SELECTs through TanStack Query for its retry handling. Every load
 * is its own uncached query: a snapshot must be read after its LIVE query opens,
 * so it can't be shared with an earlier load or served from cache.
 */
export const createSubsetLoader = ({
	queryClient,
	queryKey,
	load,
	retry,
	retryDelay,
}: SubsetLoaderConfig) => {
	let nextLoad = 0;

	return async (
		subset: LoadSubsetOptions,
		signal?: AbortSignal,
	): Promise<Row[]> => {
		const key = [...queryKey, 'surreal-subset', ++nextLoad];
		const defaults = queryClient.defaultQueryOptions({ queryKey: key });
		const policy = retry ?? defaults.retry;
		const shouldRetry = (failures: number, error: Error): boolean => {
			if (signal?.aborted) return false;
			if (policy === undefined) {
				return (
					isConnectionLoss(error) &&
					failures < DEFAULT_CONNECTION_RETRIES
				);
			}
			if (typeof policy === 'function') return policy(failures, error);
			return typeof policy === 'number' ? failures < policy : policy;
		};
		const cancel = () => {
			void queryClient.cancelQueries({ queryKey: key, exact: true });
		};
		signal?.addEventListener('abort', cancel, { once: true });

		try {
			return await queryClient.fetchQuery({
				queryKey: key,
				queryFn: () => load(subset),
				retry: shouldRetry,
				retryDelay: retryDelay ?? defaults.retryDelay,
				staleTime: 0,
				gcTime: 0,
				// The SDK queues calls while it reconnects, so don't pause here too.
				networkMode: 'always',
				structuralSharing: false,
			});
		} catch (error) {
			if (signal?.aborted && error instanceof CancelledError) return [];
			throw error;
		} finally {
			signal?.removeEventListener('abort', cancel);
			queryClient.removeQueries({ queryKey: key, exact: true });
		}
	};
};
