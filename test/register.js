// Loaded by mocha before the tests (see .mocharc.js). The test suite is written in TypeScript and executed through
// ts-node with the dedicated test/tsconfig.json, which adds the Node.js and Mocha global types. The project is passed
// here instead of the environment variable TS_NODE_PROJECT, which the repository checker rejects in .mocharc.js.
const path = require('node:path');

require('ts-node').register({ project: path.join(__dirname, 'tsconfig.json') });

// Fail the run on unhandled promise rejections instead of letting them slip through silently.
process.on('unhandledRejection', err => {
    throw err;
});
