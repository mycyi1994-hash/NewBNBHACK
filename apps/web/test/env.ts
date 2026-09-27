/**
 * The environment the route handlers see in tests (they read it through @yieldvest/config, as in
 * production): the web tests' database, a session secret, and nothing that could reach a real
 * database, key or chain — values from a developer's .env are overridden (real env wins).
 */
import { webTestUrl } from './db';

process.env.DATABASE_URL = webTestUrl ?? '';
process.env.SESSION_SECRET = 'web-tests-session-secret-0123456789abcdef';
process.env.EXECUTION_MODE = 'simulate';
process.env.HOUSE_WALLET_PRIVATE_KEY = '';
process.env.BINANCE_WEB3_API_KEY = '';
process.env.BINANCE_WEB3_API_SECRET = '';
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.JUDGE_CODES = '';
// The fake chain (setChainForTests) answers; this address refuses connections if anything leaks.
process.env.BSC_RPC_URL = 'http://127.0.0.1:9';
process.env.BSC_RPC_URL_FALLBACK = 'http://127.0.0.1:9';
