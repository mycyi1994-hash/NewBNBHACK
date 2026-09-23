/**
 * Long-running worker (SPEC §5). Jobs are registered by their tickets: tape recorder (M0-08),
 * 5-minute cycle scheduler (M1-06), guardian (M2-06). Until then it validates configuration.
 */
import { describeConfig, loadConfig } from '@ijaro/config';

const config = loadConfig();
console.log(`agent: configuration valid — ${JSON.stringify(describeConfig(config))}`);
console.log('agent: no jobs registered yet (tape M0-08, scheduler M1-06, guardian M2-06)');
