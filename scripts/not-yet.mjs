// Placeholder for commands listed in CLAUDE.md whose ticket has not been built yet.
// Usage: node scripts/not-yet.mjs <command> <ticket>
const [command, ticket] = process.argv.slice(2);
console.error(`UNAVAILABLE: \`pnpm ${command}\` is built in ${ticket} (docs/TASKS.md)`);
process.exit(3);
