import http from 'node:http';
import { beforeAll, describe, expect, it } from 'vitest';
import { egressRecords, installEgressGuard } from '../src/egress';
import { communityRequest, createAgents, parseProxy } from '../src/proxy';

/**
 * Cross-library assumption test.
 *
 * `steamcommunity` can only be proxied by handing it a pre-configured `request`
 * instance. Everything rests on `request` passing OUR agent through to
 * `http.request` unchanged — if it ever substitutes its own, the egress guard
 * sees a foreign agent and fail-closed mode blocks every confirmation call.
 *
 * `request` is deprecated (F-05), so this will not be fixed upstream if it
 * breaks. This test is the tripwire.
 *
 * Own file: the guard installs once per process.
 */

const agents = createAgents(parseProxy('socks5h://127.0.0.40:1080'));

describe('steamcommunity transport', () => {
	beforeAll(() => {
		installEgressGuard(agents, { strict: false });
	});

	it('hands our exact agent instance to the underlying http.request', async () => {
		const transport = communityRequest(agents);
		expect(transport.appliedVia).toBe('shared-agent');

		const send = transport.instance as (
			opts: Record<string, unknown>,
			cb: () => void
		) => { on(ev: string, fn: () => void): void; destroy(): void };

		const req = send({ uri: 'http://127.0.0.41:1/mobileconf/getlist', method: 'GET' }, () => {});
		req.on('error', () => {});

		await new Promise((r) => setTimeout(r, 200));

		const record = egressRecords().find((r) => r.host === '127.0.0.41');
		expect(record, 'guard never saw the request').toBeDefined();
		expect(record?.proxied).toBe(true);
		// The failure mode being guarded against: request swapping in its own agent.
		expect(record?.foreignAgent).toBe(false);
	});

	it('leaves the transport unproxied when no agents are supplied', () => {
		const transport = communityRequest(undefined);
		expect(transport.appliedVia).toBeNull();
		expect(transport.instance).toBeTypeOf('function');
	});

	it('uses one agent for both protocols on SOCKS, so identity checks hold', () => {
		expect(agents.http).toBe(agents.https);
		// Note: SocksProxyAgent extends agent-base, NOT http.Agent, so an
		// instanceof check would fail. Node accepts it structurally — it exposes
		// the agent interface — which is why proxy.ts casts to the Agent type.
		expect(typeof (agents.https as unknown as { addRequest?: unknown }).addRequest).toBe(
			'function'
		);
	});
});
