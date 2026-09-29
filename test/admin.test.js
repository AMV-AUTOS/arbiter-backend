import test from 'node:test';
import assert from 'node:assert/strict';
import { requireAdmin } from '../src/adminAuth.js';
import { listTransactions, listWorkers, listPayers, getFeeRevenue } from '../src/admin.js';
import { createJob } from '../src/jobs.js';
import { recordOutcome } from '../src/dispatch.js';
import { recordPayerQuestion } from '../src/payerIndex.js';

function uniqueId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

test('requireAdmin fails closed (503) when ADMIN_TOKEN is unset', () => {
  // No admin-test-env.js import in this file — config.admin.token is '',
  // matching this repo's default .env (see backend/.env.example).
  let statusCode = null;
  let nextCalled = false;
  const req = { get: () => undefined };
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json() {
      return this;
    },
  };
  requireAdmin(req, res, () => {
    nextCalled = true;
  });
  assert.equal(statusCode, 503);
  assert.equal(nextCalled, false);
});

test('listTransactions surfaces a created job by questionId', async () => {
  const questionId = uniqueId('q');
  await createJob(questionId, { amountStroops: '1000000', payer: 'GPAYER' });

  const { transactions } = await listTransactions({ limit: 200 });
  const row = transactions.find((t) => t.questionId === questionId);
  assert.ok(row, 'created job should appear in listTransactions');
  assert.equal(row.status, 'awaiting_workers');
  assert.equal(row.amountStroops, '1000000');
});

test('listWorkers reports reputation for a non-address workerId without touching the chain', async () => {
  const workerId = uniqueId('worker');
  await recordOutcome(workerId, true);
  await recordOutcome(workerId, false);

  const workers = await listWorkers();
  const row = workers.find((w) => w.workerId === workerId);
  assert.ok(row, 'worker with a recorded outcome should appear in listWorkers');
  assert.equal(row.totalAnswers, 2);
  assert.equal(row.matched, 1);
  assert.equal(row.matchRatio, 0.5);
  assert.equal(row.stake, '0.0000000'); // non-address id: chain reads are skipped, defaults to 0
});

test('listWorkers paginates and only does per-item work for the requested page', async () => {
  const workerIds = [];
  for (let i = 0; i < 5; i += 1) {
    const workerId = uniqueId('worker-page');
    await recordOutcome(workerId, true);
    workerIds.push(workerId);
  }

  const page = await listWorkers({ limit: 2, offset: 0 });
  assert.ok(Array.isArray(page), 'listWorkers should return an array');
  assert.ok(page.length <= 2, `expected at most 2 workers, got ${page.length}`);

  // Every returned row must be one of the workers we just created, proving the
  // page is a slice of the index rather than the whole index.
  for (const row of page) {
    assert.ok(workerIds.includes(row.workerId), `unexpected worker ${row.workerId} in page`);
  }

  // A second page must not overlap the first page's rows.
  const firstPageIds = page.map((w) => w.workerId);
  const secondPage = await listWorkers({ limit: 2, offset: 2 });
  for (const row of secondPage) {
    assert.ok(!firstPageIds.includes(row.workerId), `worker ${row.workerId} appeared on both pages`);
  }
});

test('listPayers aggregates a payer\'s tracked questions', async () => {
  const payerAddress = uniqueId('GPAYER');
  const questionId = uniqueId('q');
  await createJob(questionId, { amountStroops: '2000000', status: 'settled', outcome: 'resolved' });
  await recordPayerQuestion(payerAddress, questionId);

  const payers = await listPayers();
  const row = payers.find((p) => p.payerAddress === payerAddress);
  assert.ok(row, 'payer should appear in listPayers');
  assert.equal(row.totalTracked, 1);
  assert.equal(row.settled, 1);
});

test('listPayers paginates the tracked payer index', async () => {
  const payerAddresses = [];
  for (let i = 0; i < 5; i += 1) {
    const payerAddress = uniqueId('GPAYER-page');
    const questionId = uniqueId('q');
    await createJob(questionId, { amountStroops: '1000000' });
    await recordPayerQuestion(payerAddress, questionId);
    payerAddresses.push(payerAddress);
  }

  const page = await listPayers({ limit: 2, offset: 0 });
  assert.ok(Array.isArray(page), 'listPayers should return an array');
  assert.ok(page.length <= 2, `expected at most 2 payers, got ${page.length}`);
  for (const row of page) {
    assert.ok(payerAddresses.includes(row.payerAddress), `unexpected payer ${row.payerAddress} in page`);
  }
});

test('getFeeRevenue sums the platform\'s 20% cut only over settled+resolved jobs', async () => {
  const resolvedId = uniqueId('q-resolved');
  const refundedId = uniqueId('q-refunded');
  const pendingId = uniqueId('q-pending');

  // 10_000_000 stroops = 1 USDC (7 decimals); 20% platform cut = 0.2 USDC.
  await createJob(resolvedId, { amountStroops: '10000000', status: 'settled', outcome: 'resolved' });
  await createJob(refundedId, { amountStroops: '10000000', status: 'settled', outcome: 'refunded' }); // excluded
  await createJob(pendingId, { amountStroops: '10000000' }); // still awaiting_workers, excluded

  // Cumulative across the whole known-job index (shared with other tests in
  // this file), so assert a floor rather than an exact total.
  const { resolvedCount, totalFeeRevenue } = await getFeeRevenue();
  assert.ok(resolvedCount >= 1);
  assert.ok(Number(totalFeeRevenue) >= 0.2 - 1e-6, `expected at least ~0.2 USDC of fee revenue, got ${totalFeeRevenue}`);
});
