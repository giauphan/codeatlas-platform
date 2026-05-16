
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
    try {
        // The folder containing the Extension Manifest package.json
        // Passed to `--extensionDevelopmentPath`
        const extensionDevelopmentPath = path.resolve(__dirname, '../../../');

        // The path to the extension test script
        // Passed to --extensionTestsPath
        const extensionTestsPath = path.resolve(__dirname, './suite/index');

        // Download VS Code, unzip it and run the integration test
        await runTests({
            version: '1.85.1', // Explicitly use a known working version
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: [
                '--disable-gpu',
                '--no-sandbox',
                '--disable-gpu-sandbox',
                path.resolve(__dirname, '../../..') // Open the workspace folder
            ]
        });
    } catch (err) {
        console.error('Failed to run tests:', err);
        process.exit(1);
    }
}

main();
