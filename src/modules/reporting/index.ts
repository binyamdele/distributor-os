import 'server-only';

/**
 * The reporting read model.
 *
 * The only module in the product that adds no business truth. Everything here is a query over
 * facts other phases established, which is why it is the last one: a dashboard built before the
 * operations it summarises would have had to invent something to show.
 *
 * Two rules shape it:
 *
 *   1. **One definition per number.** `definitions.ts` holds each KPI once, and the dashboard,
 *      the daily brief and the tests all call the same function. Two screens quietly disagreeing
 *      about "outstanding receivables" would cost the owner's trust in every other figure.
 *   2. **The AI narrates and never calculates.** The snapshot is complete before a provider is
 *      consulted, the deterministic brief is written first, and a narration that fails its
 *      schema or its grounding check is discarded rather than shown.
 */

export * from './definitions';
export * from './trends';
export * from './attention';
export * from './snapshot';
export * from './brief';
export * from './narration';
