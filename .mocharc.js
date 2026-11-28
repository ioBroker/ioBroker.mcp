// Mocha configuration. test/register.js runs the TypeScript tests through ts-node.
module.exports = {
    require: './test/register.js',
    extension: ['ts'],
    spec: 'test/**/*.test.ts',
    timeout: 60000,
    exit: true,
};
