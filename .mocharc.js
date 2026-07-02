// Mocha configuration. The test suite is written in TypeScript and executed through ts-node using
// the dedicated test/tsconfig.json (which adds the Node.js and Mocha global types).
const path = require('node:path');

process.env.TS_NODE_PROJECT = path.join(__dirname, 'test', 'tsconfig.json');

// Fail the run on unhandled promise rejections instead of letting them slip through silently.
process.on('unhandledRejection', err => {
    throw err;
});

module.exports = {
    require: 'ts-node/register',
    extension: ['ts'],
    spec: 'test/**/*.test.ts',
    timeout: 60000,
    exit: true,
};
