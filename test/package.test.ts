import path from 'node:path';
import { tests } from '@iobroker/testing';

// Validate the package files (io-package.json, package.json, ...).
tests.packageFiles(path.join(__dirname, '..'));
